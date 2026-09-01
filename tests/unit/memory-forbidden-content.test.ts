import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import {
  countForbiddenContentMatches,
  loadForbiddenContentIdentities,
  persistForbiddenContentIdentities,
} from "../../src/memory-forbidden-content.js";
import { tempDb } from "../helpers.js";

describe("restart-safe forbidden content identities", () => {
  it("finds embedded forbidden bytes from content-free persisted fingerprints", async () => {
    // Given: one runtime-only value reduced to digest and rolling-window metadata.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const canary = Buffer.from("runtime-only-forbidden-memory-value");
      db.db.pragma("foreign_keys=OFF");
      persistForbiddenContentIdentities(db, { purge_id: "purge:test", material: [canary],
        observed_at: "2026-08-31T00:00:00.000Z" });
      db.db.pragma("foreign_keys=ON");
      const identities = loadForbiddenContentIdentities(db);

      // When: a later process scans bytes without receiving the original value.
      const matches = countForbiddenContentMatches(Buffer.concat([
        Buffer.from("before:"), canary, Buffer.from(":after"),
      ]), identities);

      // Then: the embedded value is found while unrelated bytes remain clean.
      expect({ identities: identities.length, matches,
        unrelated: countForbiddenContentMatches(Buffer.from("unrelated"), identities) })
        .toEqual({ identities: 1, matches: 1, unrelated: 0 });
    } finally {
      db.close();
    }
  });
});
