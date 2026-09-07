import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initialized } from "../helpers.js";
import { seedGjcDispatch } from "../fixtures/gjc-dispatch-fixture.js";

describe("dispatch through the actual CLI and a strict local coordinator process", () => {
  it.each([false, true])("preserves the task and rejects revoked authority: revoked=%s", async revoked => {
    const db = await initialized();
    const root = dirname(db.filename);
    const executable = join(root, "gjc");
    const log = join(root, "coordinator.jsonl");
    try {
      copyFileSync("tests/fixtures/gjc-dispatch-coordinator.mjs", executable);
      chmodSync(executable, 0o700);
      db.configureGjc(process.cwd(), "s", true);
      const source = seedGjcDispatch(db, "both");
      if (revoked) db.revokeAuthority(source.authorization_id, "CLI revocation fixture");
      const run = async () => {
        const { stdout } = await promisify(execFile)(process.execPath, [
          "dist/src/cli.js", "service", "once", "--db", db.filename,
        ], { cwd: process.cwd(), timeout: 15_000,
          env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, JARVIS_TEST_GJC_LOG: log } });
        return JSON.parse(stdout);
      };
      expect(await run()).toMatchObject({ ok: true, command: "service.once",
        processed: source.intent_id, state: revoked ? "failed" : "accepted" });
      if (revoked) {
        expect(existsSync(log)).toBe(false);
        expect(db.db.prepare("SELECT failure_code FROM gjc_intents WHERE intent_id=?").get(source.intent_id))
          .toEqual({ failure_code: "GJC_DISPATCH_NOT_AUTHORIZED" });
      } else {
        expect(await run()).toMatchObject({ state: "completed" });
        const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(calls.map(call => call.name)).toEqual([
          "gjc_coordinator_send_prompt", "gjc_coordinator_read_turn", "gjc_coordinator_list_questions",
        ]);
        expect(calls[0].args.idempotency_key).toBe(source.idempotency_key);
        expect(JSON.parse(calls[0].args.prompt).task).toEqual(source.census.work[0]);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_dispatch_receipts").get()).toEqual({ n: 1 });
      }
      expect(await run()).toMatchObject({ processed: null });
      expect(db.db.prepare("SELECT state FROM work_items WHERE id='codex-work'").get()).toEqual({ state: "continued" });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NOT NULL").get()).toEqual({ n: 0 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
