import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { bindStructuredProjection } from "../../src/memory-projection-bindings.js";
import { tempDb } from "../helpers.js";

const at = new Date("2026-09-09T00:00:00.000Z");
const parent = { kind: "context", id: "known", component_id: "known" } as const;
const child = { kind: "control_payload", id: "child", component_id: "child" } as const;
const nested = (levels: number, array: boolean): unknown => {
  let value: unknown = { context_id: parent.id };
  for (let i = 0; i < levels; i++) value = array ? [value] : { input: value };
  return value;
};

describe("bounded structured lineage traversal", () => {
  it.each(["wide", "cycle"])("quarantines %s input without publishing partial lineage", async shape => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const authority = new MemoryProjectionAuthority(db);
      authority.bind(parent, [{ target_digest: `sha256:${"a".repeat(64)}` }], at);
      const loop: unknown[] = []; loop.push(loop);
      const value = { context_id: parent.id, items: shape === "cycle" ? loop : Array.from({ length: 4097 }, () => null) };
      bindStructuredProjection(db.db, child, value, at);
      expect(authority.isSuppressed(child)).toBe(true);
      expect(authority.visible([child], ref => ref)).toEqual([]);
    } finally { db.close(); }
  });

  it.each([false, true])("quarantines partially collected deep input, array=%s", async array => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const authority = new MemoryProjectionAuthority(db);
      authority.bind(parent, [{ target_digest: `sha256:${"a".repeat(64)}` }], at);
      bindStructuredProjection(db.db, child, { context_id: parent.id, deep: nested(10, array) }, at);
      expect(authority.isSuppressed(child)).toBe(true);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_projection_dependencies WHERE projection_id=?")
        .get(child.id)).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("retains lineage at the supported depth boundary", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const authority = new MemoryProjectionAuthority(db);
      authority.bind(parent, [{ target_digest: `sha256:${"a".repeat(64)}` }], at);
      bindStructuredProjection(db.db, child, nested(8, false), at);
      expect(authority.isSuppressed(child)).toBe(false);
      expect(authority.hasLineage(child)).toBe(true);
    } finally { db.close(); }
  });
});
