import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, evaluatePreGjcFixture, ingestClaudeHookEvent, ingestCodexAppServerEvent, runPreGjcFixture } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const clock = "2026-08-09T00:00:00.000Z";
const success = '{"boundary":"pre_gjc_ready","aggregate_status":"stopped","completion_promoted":true,"gjc_dispatched":false}\n';
const fixture = () => JSON.parse(readFileSync("test/fixtures/pre-gjc-e2e.json", "utf8"));
const reject = (value: unknown, when = clock) => expect(() => evaluatePreGjcFixture(value, when)).toThrow("signal rejected");

describe("pre-GJC release boundary", () => {
  it("uses each provider's structured adapter and promotes only signed final stopped state", () => {
    const input = fixture();
    expect(ingestCodexAppServerEvent(input.targets[0].signals[0])).toMatchObject({ provider: "codex", state: "stopped" });
    expect(ingestClaudeHookEvent(input.targets[1].signals[0])).toMatchObject({ provider: "claude", state: "stopped" });
    expect(evaluatePreGjcFixture(input, clock)).toEqual(JSON.parse(success));
  });

  it("drives local report receipts and an injected idempotent fake resume without changing the output contract", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate(); const calls: string[] = [];
    const result = runPreGjcFixture(db, fixture(), clock, { resume: intent => { calls.push(intent.intent_id); return { intent_id: intent.intent_id, receipt: `fake:${intent.intent_id}`, delivered_at: clock }; } });
    expect(result).toEqual(JSON.parse(success)); expect(calls).toHaveLength(2); expect(new Set(calls).size).toBe(2); expect(calls.every(value => value.startsWith("resume_"))).toBe(true);
    expect(db.db.prepare("SELECT provider,state FROM pre_gjc_authority_requests ORDER BY provider").all()).toEqual([{ provider: "claude", state: "consumed" }, { provider: "codex", state: "consumed" }]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_report_outbox WHERE state='delivered'").get()).toEqual({ count: 2 }); expect(db.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_resume_intents WHERE state='delivered'").get()).toEqual({ count: 2 }); db.close();
  });

  it("fails closed for cross-provider or purpose, stale, revoked, malformed calendar/base64, and raw prose", () => {
    const missingEvidence = fixture(); missingEvidence.targets[0].evidence.pop(); reject(missingEvidence);
    const crossProvider = fixture(); crossProvider.targets[0].signals[0].progress_signal.provider = "claude"; reject(crossProvider);
    const crossPurpose = fixture(); crossPurpose.targets[0].evidence[0].key_id = "codex-progress-signal-key"; reject(crossPurpose);
    const revokedProgress = fixture(); revokedProgress.revocations.push({ key_id: "codex-progress-signal-key", provider: "codex", purpose: "progress-signal", reason: "revoked", revoked_at: "2026-08-08T23:59:00.000Z" }); reject(revokedProgress);
    const revokedEvidence = fixture(); revokedEvidence.revocations.push({ key_id: "codex-verification-key", provider: "codex", purpose: "verification", reason: "revoked", revoked_at: "2026-08-08T23:59:00.000Z" }); reject(revokedEvidence);
    const revokedCensus = fixture(); revokedCensus.revocations.push({ key_id: "claude-census-key", provider: "claude", purpose: "census", reason: "revoked", revoked_at: "2026-08-08T23:59:00.000Z" }); reject(revokedCensus);
    reject(fixture(), "2026-08-09T01:00:00.001Z");
    reject(fixture(), "2026-02-30T00:00:00.000Z");
    const malformedBase64 = fixture(); malformedBase64.targets[0].signals[0].progress_signal.signature = "not+base64"; reject(malformedBase64);
    const rawProse = fixture(); rawProse.targets[1].signals = ["Claude says it is done"]; reject(rawProse);
  });

  it("keeps the canonical npm subprocess output contract and invalid-input goldens", () => {
    const passed = spawnSync("npm", ["run", "--silent", "acceptance:pre-gjc", "--", "--fixture", "test/fixtures/pre-gjc-e2e.json", "--clock", clock], { encoding: "utf8" });
    expect({ status: passed.status, stdout: passed.stdout, stderr: passed.stderr }).toEqual({ status: 0, stdout: success, stderr: "" });
    const cases: Array<[string, (input: any) => void]> = [
      ["bad-signal", input => { input.targets[0].signals[0].progress_signal.signature = "bad"; }],
      ["revoked-census", input => { input.revocations.push({ key_id: "claude-census-key", provider: "claude", purpose: "census", reason: "revoked", revoked_at: "2026-08-08T23:59:00.000Z" }); }],
      ["raw-prose", input => { input.targets[0].signals = ["completed"]; }]
    ];
    for (const [name, mutate] of cases) {
      const path = join(mkdtempSync(join(tmpdir(), `pre-gjc-${name}-`)), "fixture.json");
      const invalid = fixture(); mutate(invalid); writeFileSync(path, JSON.stringify(invalid));
      const failed = spawnSync("node", ["scripts/pre-gjc-acceptance.mjs", "--fixture", path, "--clock", clock], { encoding: "utf8" });
      expect({ status: failed.status, stdout: failed.stdout, stderr: failed.stderr }).toEqual({ status: 1, stdout: "", stderr: "E_SIGNAL_FAIL_CLOSED\n" });
    }
  }, 30_000);
});
