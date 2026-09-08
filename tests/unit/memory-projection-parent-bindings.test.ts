import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { bindNotificationProjection, bindStructuredProjection } from "../../src/memory-projection-bindings.js";
import { tempDb } from "../helpers.js";

const at = new Date("2026-09-09T00:00:00.000Z");
const known = { kind: "context", id: "known", component_id: "known" } as const;
const other = { kind: "context", id: "other", component_id: "other" } as const;
const digest = `sha256:${"a".repeat(64)}`;

describe.each(["notification", "structured"] as const)("%s parent binding", producer => {
  it.each(["mixed", "resolved", "untracked"] as const)("preserves the full parent list for %s inputs", async state => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const authority = new MemoryProjectionAuthority(db);
      const child = { kind: producer === "notification" ? "notification_intent" : "control_payload",
        id: "child", component_id: "child" } as const;
      if (state !== "untracked") authority.bind(known, [{ target_digest: digest }], at);
      if (state === "resolved") authority.bind(other, [{ target_digest: `sha256:${"b".repeat(64)}` }], at);
      if (producer === "notification") bindNotificationProjection(db.db, child.id, [], [known.id, other.id], at);
      else bindStructuredProjection(db.db, child, { inputs: [{ context_id: known.id }, { context_id: other.id }] }, at);
      expect(authority.isSuppressed(child)).toBe(state === "mixed");
      const count = db.db.prepare("SELECT COUNT(*) AS count FROM memory_projection_dependencies WHERE projection_id=?")
        .get(child.id) as { count: number };
      expect(count.count).toBe(state === "resolved" ? 2 : 0);
      if (state === "mixed") {
        expect(authority.visible([child], ref => ref)).toEqual([]);
        expect(db.db.prepare("SELECT reason_code FROM memory_projection_quarantine WHERE projection_id=?")
          .get(child.id)).toEqual({ reason_code: "lineage_unresolved" });
      }
      if (state === "untracked") expect(authority.hasLineage(child)).toBe(false);
    } finally { db.close(); }
  });
});
