import { describe, expect, it } from "vitest";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { AuthorityDb } from "../../src/db.js";
import { TASK32_NOW, task32Evidence } from "../fixtures/task32-memory-test-support.js";
import { tempDb } from "../helpers.js";

const INTENT_A = `memui:intent:v1:${"1".repeat(64)}`;
const INTENT_B = `memui:intent:v1:${"2".repeat(64)}`;

describe("Task 32 semantic attempt restage", () => {
  it("creates one generation-2 successor linked to an expired predecessor", async () => {
    // Given
    let now = TASK32_NOW;
    const authority = new AuthorityDb(tempDb()); await authority.migrate();
    const session = createDashboardSession("owner-session");
    const tokens = new MemoryTokenCache(Buffer.alloc(32, 5), () => now);
    const service = new MemoryMutationService({ authority, tokens, session, clock: () => now });
    const firstToken = tokens.issue(task32Evidence(), session.authenticatedSessionId(), 0);
    if (firstToken === undefined) throw new TypeError("first token required");
    const first = await service.stageEffect({ operation: "export", intent_id: INTENT_A,
      token: firstToken.token, record_revision: firstToken.record_revision, payload: { format: "json" } });
    if (first === undefined) throw new TypeError("first attempt required");
    authority.db.prepare(
      "UPDATE memory_surface_effect_attempts SET state='expired',updated_at=? WHERE control_request_id=?",
    ).run("2026-09-01T00:15:00.000Z", first.request_id);
    authority.db.prepare(
      "UPDATE control_command_requests SET state='cancelled',completed_at=?,failure_code='MEMORY_INTENT_EXPIRED' WHERE request_id=?",
    ).run("2026-09-01T00:15:00.000Z", first.request_id);
    now = new Date(TASK32_NOW.getTime() + 1);
    const successorToken = tokens.issue(task32Evidence(), session.authenticatedSessionId(), 0);
    if (successorToken === undefined) throw new TypeError("successor token required");
    // When
    const successor = await service.stageEffect({ operation: "export", intent_id: INTENT_B,
      token: successorToken.token, record_revision: successorToken.record_revision, payload: { format: "json" } });
    // Then
    expect(successor?.request_id).not.toBe(first.request_id);
    expect(authority.db.prepare(
      `SELECT attempt_generation,predecessor_attempt_id FROM memory_surface_effect_attempts
       ORDER BY attempt_generation`,
    ).all()).toEqual([{ attempt_generation: 1, predecessor_attempt_id: null },
      { attempt_generation: 2, predecessor_attempt_id: expect.stringMatching(/^memui:effect-attempt:v1:/) }]);
    authority.close();
  });
});
