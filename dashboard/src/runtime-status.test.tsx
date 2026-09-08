import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeIdentityReport } from "../../src/runtime-identity-contracts.js";
import { RuntimeStatus } from "./runtime-status.js";
import { createDashboardClient } from "./api.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";

const hash = `sha256:${"a".repeat(64)}`;
const sample: RuntimeIdentityReport = {
  schema_version: 1,
  process: { pid: 42, started_at: "2026-09-08T00:00:00.000Z", node: "v24.0.0", modules: "137", platform: "linux", arch: "x64" },
  build: { status: "matched", checked_at: "2026-09-08T00:00:01.000Z", source_head: "a".repeat(40),
    source_dirty: true, input_digest: hash, artifact_digest: hash, observed_artifact_digest: hash,
    artifact_files: 1044, migration_digest: hash, migration_count: 70, toolchain_status: "matched" },
  database: { status: "matched", observed_at: "2026-09-08T01:00:00.000Z", applied_migrations: 70,
    migration_digest: hash, missing: 0, unexpected: 0, changed: 0, schema_objects: 200, schema_digest: hash },
};

afterEach(() => vi.unstubAllGlobals());
const response = (runtime?: unknown) => ({ schema_version: 1, generated_at: sample.build.checked_at,
  cards: [], recent_tasks: [], pending_approvals: [], risks: [], agents: [], portfolio: unseenPortfolio,
  ...(runtime === undefined ? {} : { runtime }) });
function serve(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe("runtime API response boundary", () => {
  it("accepts valid identity and the absent field from an older server", async () => {
    serve(response(sample)); expect((await createDashboardClient().overview()).runtime).toEqual(sample);
    serve(response()); expect((await createDashboardClient().overview()).runtime).toBeUndefined();
  });
  it.each([
    null, {}, [], { ...sample, schema_version: 2 }, { ...sample, process: {} }, { ...sample, build: {} },
    { ...sample, database: {} }, { ...sample, build: { ...sample.build, status: "bogus" } },
    { ...sample, process: { ...sample.process, pid: -1 } },
    { ...sample, database: { ...sample.database, applied_migrations: 1.5 } },
    { ...sample, build: { ...sample.build, source_dirty: "false" } },
    { ...sample, build: { ...sample.build, checked_at: "2026-02-30T00:00:00.000Z" } },
    { ...sample, build: { ...sample.build, artifact_digest: "private malformed value" } },
    { ...sample, database: { ...sample.database, unexpected: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects malformed runtime before it reaches the component (%#)", async runtime => {
    serve(response(runtime));
    await expect(createDashboardClient().overview()).rejects.toMatchObject({ code: "VALIDATION_ERROR", kind: "server" });
  });
});

describe("runtime identity details", () => {
  it("makes missing legacy API data explicit", () => {
    render(<RuntimeStatus />);
    expect(screen.getByText("서버 실행 식별 정보가 제공되지 않았습니다.")).toBeVisible();
    expect(screen.queryByText(/파일 일치/)).not.toBeInTheDocument();
  });
  it("opens the source and DB details and distinguishes dirty source and schema limitations", async () => {
    const { container } = render(<RuntimeStatus runtime={sample} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("현황판 서버 실행 정보 · 파일 일치 · DB 기록 일치"));
    expect(details.open).toBe(true);
    expect(screen.getByText("a".repeat(40))).toBeVisible();
    expect(screen.getByText("변경 포함")).toBeVisible();
    expect(screen.getByText("기록 일치 · 적용 70 / 빌드 70")).toBeVisible();
    expect(screen.getByText(/마이그레이션 기록 일치는 실제 DB 구조의 정상 판정을 대신하지 않습니다/)).toBeVisible();
  });
  it("updates mismatches and clears a former identity when a legacy server responds", () => {
    const { rerender } = render(<RuntimeStatus runtime={sample} />);
    rerender(<RuntimeStatus runtime={{ ...sample, build: { ...sample.build, status: "mismatch", toolchain_status: "mismatch" },
      database: { ...sample.database, status: "mismatch", missing: 2, unexpected: 1, changed: 3 } }} />);
    expect(screen.getByText("현황판 서버 실행 정보 · 파일 불일치 · DB 적용 차이 있음")).toBeVisible();
    expect(screen.getByText("누락 2 · 추가 1 · 변경 3")).toBeInTheDocument();
    rerender(<RuntimeStatus />);
    expect(screen.queryByText("a".repeat(40))).not.toBeInTheDocument();
  });
});
