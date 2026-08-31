import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { DataVersionObserver } from "../../src/dashboard/events.js";
import { PERSONAL_TOPICS } from "../../src/dashboard/personal-contracts.js";
import { tempDb } from "../helpers.js";

describe("notification cross-connection invalidation", () => {
  it("publishes notification and Today after an external intent transaction", async () => {
    // Given
    const path = tempDb(); const reader = new AuthorityDb(path); await reader.migrate();
    const writer = new AuthorityDb(path); const topics: string[][] = [];
    const observer = new DataVersionObserver(reader, value => { topics.push([...value]); });
    try {
      // When
      writer.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
        redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run("ntf:pos:v1:event", "thread:event", "idem:event", "dedup:event", "info", "mac", "Review decision",
          "/recommendations/rec%3Apos%3Av1%3Aone?rank=1", "created", "2026-08-28T13:00:00.000Z",
          "2026-08-28T12:00:00.000Z", "2026-08-28T12:00:00.000Z");
      const changed = observer.check();
      // Then
      expect(changed).toBe(true);
      expect(topics).toEqual([[PERSONAL_TOPICS.notifications, PERSONAL_TOPICS.today]]);
    } finally { writer.close(); reader.close(); }
  });
});
