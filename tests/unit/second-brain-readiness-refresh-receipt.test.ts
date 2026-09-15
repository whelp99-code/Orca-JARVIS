import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import { secondBrainRefreshObservation } from "../../src/second-brain-readiness-refresh.js";
import {
  runtimeSecondBrainReadinessProbe,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";
import type { SecondBrainReadFacts } from "../../src/second-brain-readiness-read.js";

const PROVIDER_DOCTOR = JSON.stringify([{ name: "vault", status: "pass", detail: "ok" }]);
const PROVIDER_STATUS = "2026-09-15T20:14:11.462201+09:00 run 262285d94b7d ok pages=1 conflicts=0 errors=0\n";
const NOW = new Date("2026-09-15T11:30:00.000Z");

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "jarvis-sb-receipt-")); roots.push(value); return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

/** The exact document the provider release publishes at `refresh_receipt_path`. */
function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    profile: "daily-refresh-receipt-v1",
    receipt: {
      schema_version: 1,
      refresh_id: "262285d94b7d",
      state: "completed",
      completed_at: "2026-09-15T11:14:11.462Z",
      protocol_version: 1,
      capped: false,
      ...overrides,
    },
  });
}

function published(body: string): string {
  const directory = root();
  const path = join(directory, "refresh-receipt.json");
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
  return path;
}

function runner(read: Partial<SecondBrainReadFacts> = {}): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => ({ kind: "ok", stdout: command === "doctor" ? PROVIDER_DOCTOR : PROVIDER_STATUS }),
    handshake: async () => ({
      kind: "ok", stdout: "",
      facts: {
        protocol_version: "2025-11-25", server_name: "second-brain", server_version: "",
        tools: [...SECOND_BRAIN_REQUIRED_TOOLS], input_schemas_compatible: true,
        output_schemas_compatible: true,
      },
      read: { read: "authorized", contract_digest: SECOND_BRAIN_FROZEN_DIGEST, data_state: "ready", ...read },
    }),
  };
}

async function report(receiptPath: string | undefined, read: Partial<SecondBrainReadFacts> = {}) {
  const observation = await runtimeSecondBrainReadinessProbe(runner(read), receiptPath).inspect();
  return {
    observation,
    staged: evaluateSecondBrainReadiness(observation as SecondBrainReadinessObservation, NOW),
  };
}

describe("readiness reads the provider's refresh receipt", () => {
  it("reports a completed receipt as the last successful refresh and its freshness", async () => {
    // Given: the provider published a completed receipt for the run the status line names.
    const path = published(receipt());
    // When: readiness is probed with that receipt.
    const { observation, staged } = await report(path);
    // Then: the completion instant comes from the receipt, not from the run's start.
    expect(observation.refresh).toEqual({ kind: "success", completed_at: "2026-09-15T11:14:11.462Z" });
    expect(staged.stages.last_successful_refresh).toMatchObject({
      state: "current_date", reason: "refresh_current_date",
      observed_at: "2026-09-15T11:14:11.462Z", latest_attempt: "success",
    });
    expect(staged.stages.freshness).toMatchObject({ state: "fresh", reason: "within_threshold" });
  });

  it("holds a failed refresh apart from a missing one", async () => {
    // Given: the last refresh failed, and said so rather than deleting the file.
    const { observation, staged } = await report(published(receipt({ state: "failed" })));
    // Then: there is no successful completion, and the attempt is recorded as a failure.
    expect(observation.refresh).toEqual({ kind: "failed", attempted_at: "2026-09-15T11:14:11.462Z" });
    expect(staged.stages.last_successful_refresh).toMatchObject({
      state: "missing", reason: "refresh_missing", observed_at: null, latest_attempt: "failed",
    });
  });

  it("does not launder a capped refresh into a complete one", async () => {
    // Given: a cap clipped the run.
    const { observation, staged } = await report(published(receipt({ capped: true })));
    // Then: the cap is reported, and no successful completion is claimed from it.
    expect(observation.refresh).toEqual({ kind: "capped", attempted_at: "2026-09-15T11:14:11.462Z" });
    expect(staged.stages.last_successful_refresh).toMatchObject({ state: "missing", latest_attempt: "capped" });
    expect(staged.stages.freshness).toMatchObject({ state: "unknown", reason: "successful_refresh_missing" });
  });

  it("refuses a receipt from an unnegotiated protocol, profile or envelope", () => {
    // Given: documents a provider might publish that this build never agreed to read.
    const cases = [
      published(receipt({ protocol_version: 2 })),
      published(JSON.stringify({ schema_version: 1, profile: "daily-refresh-receipt-v2", receipt: {} })),
      published(JSON.stringify({ schema_version: 1, profile: "daily-refresh-receipt-v1", receipt: {}, extra: 1 })),
      published("not json"),
      join(root(), "absent.json"),
    ];
    // Then: none of them becomes refresh evidence.
    for (const path of cases) expect(secondBrainRefreshObservation(path)).toBeUndefined();
    // And: no receipt configured at all is not evidence either.
    expect(secondBrainRefreshObservation(undefined)).toBeUndefined();
  });

  it("refuses a receipt that is not a regular file", () => {
    // Given: a symlink where the receipt should be.
    const directory = root();
    const target = join(directory, "real.json");
    writeFileSync(target, `${receipt()}\n`);
    const link = join(directory, "refresh-receipt.json");
    symlinkSync(target, link);
    // Then: the reader opens O_NOFOLLOW, so the link is not followed into evidence.
    expect(secondBrainRefreshObservation(link)).toBeUndefined();
  });

  it("keeps the legacy attempt when no receipt is published", async () => {
    // Given: a provider whose hourly run succeeded but publishes no receipt.
    const { observation, staged } = await report(undefined);
    // Then: the attempt is still reported, and the stage still has no completion.
    expect(observation.refresh).toEqual({ kind: "success_attempted", attempted_at: "2026-09-15T11:14:11.462Z" });
    expect(staged.stages.last_successful_refresh).toMatchObject({ state: "missing", latest_attempt: "success" });
  });
});

describe("readiness consumes the provider's write authorization", () => {
  it("reports read/write when the provider authorizes this deployment's key", async () => {
    // Given: a provider that answers `write_authorization: "authorized"` on its read surface,
    // and a published receipt, so nothing else holds readiness below ready.
    const { staged } = await report(published(receipt()), { write: "authorized" });
    // Then: the write is granted without readiness ever performing one.
    expect(staged.stages.authorized).toMatchObject({ state: "read_write", reason: "authorized", read: true, write: true });
    expect(staged.readiness).toBe("ready");
  });

  it("distinguishes a disabled write surface from a refused key", async () => {
    // Given: a provider whose key surface cannot admit anyone, and one that refuses this caller.
    const disabled = await report(published(receipt()), { write: "disabled" });
    const refused = await report(published(receipt()), { write: "unauthorized" });
    // Then: each keeps reads and reports its own reason.
    expect(disabled.staged.stages.authorized).toMatchObject({ state: "read_only", reason: "write_disabled" });
    expect(refused.staged.stages.authorized).toMatchObject({ state: "read_only", reason: "write_unauthorized" });
  });

  it("stays read_only against a provider release that does not report the field", async () => {
    // Given: the older provider, which says nothing about write authorization.
    const { observation, staged } = await report(published(receipt()));
    // Then: silence is never read as a grant.
    expect(observation.write_authorization).toBe("unauthorized");
    expect(staged.stages.authorized).toMatchObject({ state: "read_only", reason: "write_unauthorized", write: false });
  });
});
