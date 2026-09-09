import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { pageControlCommands } from "../../src/control-command-page.js";

it("advances over a hidden span and rechecks visibility between pages without writes", async () => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const insert = db.db.prepare(`INSERT INTO control_command_requests
      (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES (?,'workflow.start',2,'{}','{}',?,1,'test',?, ?,?,'pending',?)`);
    const hide = db.db.prepare(`INSERT INTO memory_projection_quarantine
      (projection_kind,projection_id,component_id,reason_code,detected_at) VALUES ('control_payload',?,?,'lineage_unresolved',?)`);
    const at = "2026-09-10T00:00:00.000Z";
    db.db.transaction(() => {
      for (let i = 0; i < 503; i++) {
        const id = String(i).padStart(5, "0");
        insert.run(id, `sha256:${i.toString(16).padStart(64, "0")}`, at, "2026-09-11T00:00:00.000Z", id, at);
        if (i < 500) hide.run(id, id, at);
      }
    })();
    const before = db.db.serialize();
    const first = pageControlCommands(db, 1);
    expect(first.requests).toEqual([]); expect(first.page.scanned).toBe(500);
    const second = pageControlCommands(db, 1, first.page.next_cursor!);
    expect(second.requests.map(row => row.request_id)).toEqual(["00500"]);
    expect(db.db.serialize().equals(before)).toBe(true);
    hide.run("00501", "00501", at);
    const hidden = db.db.serialize();
    const last = pageControlCommands(db, 1, second.page.next_cursor!);
    expect(last.requests.map(row => row.request_id)).toEqual(["00502"]);
    expect(last.page.next_cursor).toBeNull();
    expect(db.db.serialize().equals(hidden)).toBe(true);
    expect(() => pageControlCommands(db, 0)).toThrow("VALIDATION_ERROR");
    expect(() => pageControlCommands(db, 1, "bad")).toThrow("VALIDATION_ERROR");
    db.db.prepare("UPDATE control_command_requests SET rowid=rowid+10000 WHERE request_id='00500'").run();
    expect(() => pageControlCommands(db, 1, second.page.next_cursor!)).toThrow("CONTROL_PAGE_STALE");
  } finally { db.close(); }
});
