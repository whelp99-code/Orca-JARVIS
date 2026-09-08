import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonRuntimeIdentityReport } from "../../src/daemon-runtime-identity.js";
import { DaemonRuntimeStatus } from "./daemon-runtime-status.js";
import { createDashboardClient } from "./api.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";
import { liveStore, dataOf } from "./store-test-harness.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";

const now = "2026-09-08T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const active: DaemonRuntimeIdentityReport = {
  schema_version: 1, status: "active", reason: null, observed_at: now, recorded_at: now,
  lease: { fence: 2, heartbeat_at: now, expires_at: "2026-09-08T00:01:00.000Z" },
  snapshot: { schema_version: 1, process: { pid: 812, started_at: now, node: "v24.19.0", modules: "137", platform: "linux", arch: "x64" },
    incarnation: { boot_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", pid_namespace: "pid:[1234]", start_token: "456" },
    build: { status: "matched", checked_at: now, source_head: "a".repeat(40), source_dirty: false,
      input_digest: hash, artifact_digest: hash, observed_artifact_digest: hash, artifact_files: 1057,
      migration_digest: hash, migration_count: 71, toolchain_status: "matched" } },
};
const unknown: DaemonRuntimeIdentityReport = { schema_version: 1, status: "unknown", reason: "missing",
  observed_at: now, recorded_at: null, lease: null, snapshot: null };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function serve(daemon?: unknown) {
  const body = { schema_version: 1, generated_at: now, cards: [], recent_tasks: [], pending_approvals: [], risks: [],
    agents: [], portfolio: unseenPortfolio, ...(daemon === undefined ? {} : { daemon_identity: daemon }) };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe("daemon identity response boundary", () => {
  it.each([active, unknown, { ...active, status: "inactive", reason: "lease_expired", observed_at: "2026-09-08T00:01:00.000Z" },
    { ...active, status: "stale", reason: "lease_changed" },
    { ...active, status: "inactive", reason: "lease_missing", lease: null },
    { ...active, status: "unknown", reason: "lease_invalid", lease: null },
    { ...active, status: "unknown", reason: "namespace_unobservable" },
    { ...unknown, reason: "clock_invalid", observed_at: null }, undefined])("accepts a current or legacy report (%#)", async daemon => {
    serve(daemon); expect((await createDashboardClient().overview()).daemon_identity).toEqual(daemon);
  });
  it.each([null, {}, { ...active, schema_version: 2 }, { ...active, status: "ready" }, { ...active, reason: "missing" },
    { ...active, snapshot: null }, { ...active, lease: null }, { ...active, observed_at: null },
    { ...active, recorded_at: "2026-02-30T00:00:00.000Z" }, { ...active, lease: { ...active.lease, fence: -1 } },
    { ...active, lease: { ...active.lease, expires_at: now } },
    { ...active, snapshot: { ...active.snapshot, incarnation: null } },
    { ...active, snapshot: { ...active.snapshot, incarnation: { ...active.snapshot!.incarnation, start_token: "bad" } } },
    { ...active, snapshot: { ...active.snapshot, build: { ...active.snapshot!.build, artifact_digest: "bad" } } },
    { ...active, status: "unknown", reason: "missing" }, { ...active, status: "unknown", reason: "invalid" },
    { ...active, status: "unknown", reason: "unavailable" }, { ...active, status: "unknown", reason: "clock_invalid" },
    { ...unknown, status: "inactive", reason: "lease_expired" },
    { ...active, status: "inactive", reason: "lease_expired" },
    { ...unknown, status: "stale", reason: "process_missing" },
    { ...active, status: "stale", reason: "process_missing", lease: null },
  ])("rejects malformed or unsupported active claims (%#)", async daemon => {
    serve(daemon); await expect(createDashboardClient().overview()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("daemon identity details", () => {
  it("opens persisted build and lease details without equating them to business readiness", async () => {
    const { container } = render(<DaemonRuntimeStatus daemon={active} />);
    await userEvent.click(screen.getByText("작업 데몬 · 관측 시점에 lease·프로세스 일치"));
    expect(container.querySelector("details")!.open).toBe(true);
    expect(screen.getByText("a".repeat(40))).toBeVisible();
    expect(screen.getByText(/PID 812/)).toBeVisible();
    expect(screen.getByText(/업무 처리 준비 여부는 별도로/)).toBeVisible();
  });
  it("replaces an active report with exit, missing and legacy states without retaining old build details", () => {
    const { rerender } = render(<DaemonRuntimeStatus daemon={active} />);
    rerender(<DaemonRuntimeStatus daemon={{ ...active, status: "stale", reason: "process_exited" }} />);
    expect(screen.getByText("작업 데몬 · 이전 실행 관측")).toBeVisible();
    expect(screen.getByText("프로세스 종료 중")).toBeInTheDocument();
    expect(screen.queryByText(/관측 시점에 lease·프로세스 일치/)).not.toBeInTheDocument();
    rerender(<DaemonRuntimeStatus daemon={unknown} />);
    expect(screen.getByText("작업 데몬 · 상태 확인 불가")).toBeVisible();
    expect(screen.queryByText(/PID 812/)).not.toBeInTheDocument();
    rerender(<DaemonRuntimeStatus />);
    expect(screen.getByText("작업 데몬 식별 정보가 제공되지 않았습니다.")).toBeVisible();
    expect(screen.queryByText("a".repeat(40))).not.toBeInTheDocument();
  });
});

describe("daemon lease freshness without SSE writes", () => {
  it("refreshes at lease expiry despite browser clock skew and stops scheduling inactive reports", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const { store, client } = await liveStore();
    try {
      client.data.overview = { ...client.data.overview, daemon_identity: active };
      await store.refreshOverview(); const before = client.calls.overview;
      client.data.overview = { ...client.data.overview, daemon_identity: { ...active, status: "inactive", reason: "lease_expired", observed_at: "2026-09-08T00:01:00.000Z" } };
      await vi.advanceTimersByTimeAsync(59_999); expect(client.calls.overview).toBe(before);
      await vi.advanceTimersByTimeAsync(1); expect(client.calls.overview).toBe(before + 1);
      expect(dataOf<OverviewResponse>(store.getSnapshot().overview).daemon_identity?.status).toBe("inactive");
      await vi.advanceTimersByTimeAsync(120_000); expect(client.calls.overview).toBe(before + 1);
    } finally { store.stop(); }
  });
  it("replaces the old expiry timer on renewal and cancels it when stopped", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    const { store, client } = await liveStore();
    try {
      client.data.overview = { ...client.data.overview, daemon_identity: active }; await store.refreshOverview();
      await vi.advanceTimersByTimeAsync(10_000);
      client.data.overview = { ...client.data.overview, daemon_identity: { ...active, observed_at: "2026-09-08T00:00:10.000Z",
        lease: { ...active.lease!, expires_at: "2026-09-08T00:01:30.000Z" } } };
      await store.refreshOverview(); const before = client.calls.overview;
      await vi.advanceTimersByTimeAsync(50_000); expect(client.calls.overview).toBe(before);
      store.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(client.calls.overview).toBe(before);
    } finally { store.stop(); }
  });
});
