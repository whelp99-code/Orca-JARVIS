import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { memoryOutboxFailure, tagMemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";

describe("memory outbox diagnostic cause codes", () => {
  it.each(["getter", "prototype", "revoked"])("classifies a throwing %s without losing the tagged phase", kind => {
    const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    let reads = 0;
    Object.defineProperty(error, "code", { get: () => { reads += 1; throw new Error("PRIVATE_SENTINEL"); } });
    let thrown: unknown = error;
    if (kind === "prototype") thrown = new Proxy(error, {
      getPrototypeOf() { throw new Error("PRIVATE_SENTINEL"); },
    });
    if (kind === "revoked") {
      const { proxy, revoke } = Proxy.revocable(error, {});
      revoke(); thrown = proxy;
    }

    const failure = memoryOutboxFailure(tagMemoryOutboxFailure("provider_observation", thrown));

    expect(failure).toEqual({ phase: "provider_observation",
      error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" });
    expect(reads).toBe(kind === "getter" ? 1 : 0);
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
  });

  it.each(["getter", "proxy"])("preserves the approved snapshot from a stateful %s", kind => {
    const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    let reads = 0;
    const readCode = () => ++reads === 1 ? "MEMORY_OUTBOX_STALE_FENCE" : "PRIVATE_SENTINEL";
    if (kind === "getter") Object.defineProperty(error, "code", { get: readCode });
    const thrown = kind === "proxy" ? new Proxy(error, {
      get(target, property, receiver) {
        return property === "code" ? readCode() : Reflect.get(target, property, receiver);
      },
    }) : error;

    const failure = memoryOutboxFailure(thrown);

    expect(failure.cause_code).toBe("MEMORY_OUTBOX_STALE_FENCE");
    expect(reads).toBe(1);
  });

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
