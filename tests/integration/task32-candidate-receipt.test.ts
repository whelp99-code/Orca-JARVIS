import { describe, expect, it } from "vitest";
import { validateControlAction } from "../../src/control-actions.js";

const candidateId = `memcand:pos:v1:${"a".repeat(64)}`;
const digest = `sha256:${"b".repeat(64)}`;

describe("Task 32 candidate receipt truth table", () => {
  it("accepts the content-free remember confirmation command shape", () => {
    // Given
    const command = {
      action: "memory.confirm",
      action_level: 3,
      target: {
        candidate_id: candidateId,
        candidate_digest: digest,
        classification_digest: digest,
      },
      args: {
        schema_version: 1,
        operation: "remember",
        decision: "confirm",
        content_digest: digest,
        review_spool_digest: digest,
      },
    };

    // When
    const descriptor = validateControlAction(command);

    // Then
    expect(descriptor).toEqual({
      action: "memory.confirm",
      minimum_level: 3,
      executable: false,
    });
  });
});
