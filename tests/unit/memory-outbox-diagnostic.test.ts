import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { memoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";

describe("memory outbox diagnostic cause codes", () => {
  it.each(["PRIVATE_SENTINEL", "MEMORY_OUTBOX_PRIVATE_SENTINEL"])(
    "hides unapproved uppercase cause code %s",
    code => {
      expect(memoryOutboxFailure(new JarvisError(code)).cause_code)
        .toBe("MEMORY_OUTBOX_UNCLASSIFIED_ERROR");
    },
  );

  it.each([
    "MEMORY_READ_FENCE_KEY_UNAVAILABLE",
    "MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE",
    "MEMORY_OUTBOX_STALE_FENCE",
    "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID",
    "MEMORY_OUTBOX_EVIDENCE_CONFLICT",
  ])("preserves approved producer cause %s", code => {
    expect(memoryOutboxFailure(new JarvisError(code)).cause_code).toBe(code);
  });
});
