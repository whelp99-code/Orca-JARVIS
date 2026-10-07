import { describe, expect, it } from "vitest";
import { openWorkboardFixture, WORKBOARD_FIXTURE_NOW } from "../fixtures/workboard-fixture.js";
import { readWorkboard } from "../../src/workboard/projection.js";

describe("workboard source projection", () => {
  it("returns sources without work rows, preserving unknown coverage and the failure reason", () => {
    const db = openWorkboardFixture();
    try {
      db.prepare("INSERT INTO workboard_sources(source_key,coverage,warning) VALUES(?,?,?)")
        .run("mac:mail:local:initial", "unknown", "no consented metadata API/session enumeration configured");
      db.pragma("query_only = ON");
      const result = readWorkboard(db, WORKBOARD_FIXTURE_NOW);
      expect(result.sources).toContainEqual({ source_key: "mac:mail:local:initial", coverage: "unknown",
        warning: "no consented metadata API/session enumeration configured", current_work_total: null });
      expect(result.works).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});
