import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { withVisibleControlCommandReader } from "../../src/task-work-lineage-visibility.js";

it.each([
  { name: "row capacity", count: 300, text: "" },
  { name: "UTF-8 text capacity", count: 200, text: "가".repeat(2000) },
  { name: "one oversized row", count: 1, text: "가".repeat(350000) },
])("reads uncached rows after $name without losing content or writing", async ({ count, text }) => {
  const db = new AuthorityDb(":memory:"); await db.migrate();
  try {
    const insert = db.db.prepare(`INSERT INTO control_command_requests
      (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES (?,'workflow.start',2,'{}',?, ?,1,'test',?, ?,?,'pending',?)`);
    const at = "2026-09-10T00:00:00.000Z";
    const args = JSON.stringify({ text });
    db.db.transaction(() => {
      for (let i = 0; i < count; i++) insert.run(String(i), args,
        `sha256:${i.toString(16).padStart(64, "0")}`, at, "2026-09-11T00:00:00.000Z", String(i), at);
    })();
    const before = db.db.serialize();
    const original = db.db.prepare.bind(db.db);
    const reads: string[] = [];
    const spy = vi.spyOn(db.db, "prepare").mockImplementation(sql => {
      const statement = original(sql);
      if (sql === "SELECT * FROM control_command_requests WHERE request_id=?") {
        const get = statement.get.bind(statement);
        statement.get = (...bindings: any[]) => { reads.push(String(bindings[0])); return get(...bindings); };
      }
      return statement;
    });
    try {
      withVisibleControlCommandReader(db, read => {
        for (let i = 0; i < count; i++) expect(read(String(i))?.args_json).toBe(args);
        expect(read(String(count - 1))?.args_json).toBe(args);
        expect(read("0")?.args_json).toBe(args);
      });
      expect(reads.filter(id => id === String(count - 1))).toHaveLength(count === 1 ? 3 : 2);
      if (count > 1) expect(reads.filter(id => id === "0")).toHaveLength(1);
    } finally { spy.mockRestore(); }
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
