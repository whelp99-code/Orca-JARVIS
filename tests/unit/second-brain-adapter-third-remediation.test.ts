import { describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { NOW, QueuedTransport } from "../fixtures/second-brain-adapter-fixtures.js";

function malformedOutcome(value: unknown) {
  const target = { kind: "data", value: {} } as const;
  return new Proxy(target, {
    get: (object, key, receiver) => key === "value" ? value : Reflect.get(object, key, receiver),
  });
}

function reader(value: unknown) {
  return createSecondBrainReadAdapter({
    transport: new QueuedTransport([malformedOutcome(value)]),
    budgets: { max_hits: 2, max_excerpt_bytes: 128, max_total_bytes: 65_536, max_page_bytes: 65_536 },
    clock: () => NOW,
    max_age_ms: 86_400_000,
    expiry_ms: 172_800_000,
  });
}

function expectProviderInvalid(result: SecondBrainReadOutcome): void {
  expect(result).toEqual({
    kind: "invalid",
    code: "SECOND_BRAIN_PROVIDER_VALUE_INVALID",
    checked_at: NOW.toISOString(),
  });
  expect("evidence" in result).toBe(false);
  expect("conflicts" in result).toBe(false);
}

describe("Second Brain provider record public boundary", () => {
  it("returns typed invalid for every unsupported top-level provider value", async () => {
    const values: readonly unknown[] = [
      null,
      "scalar",
      1,
      true,
      [],
      undefined,
      1n,
      Symbol("provider"),
      () => "provider",
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];

    for (const value of values) expectProviderInvalid(await reader(value).search("fixture"));
  });

  it("rejects non-plain records and trap-bearing values before parser reads", async () => {
    const nullPrototype = Object.create(null);
    Object.defineProperty(nullPrototype, "results", { enumerable: true, value: [] });
    const customPrototype = Object.create({ inherited: true });
    Object.defineProperty(customPrototype, "results", { enumerable: true, value: [] });
    const accessor = { results: [] };
    Object.defineProperty(accessor, "hidden", { enumerable: true, get: () => { throw new TypeError("GETTER_SECRET"); } });
    const hidden = { results: [] };
    Object.defineProperty(hidden, "secret", { enumerable: false, value: "HIDDEN_SECRET" });
    const symbol = { results: [] };
    Object.defineProperty(symbol, Symbol("secret"), { enumerable: true, value: "SYMBOL_SECRET" });
    const sparse = { results: new Array<unknown>(2) };
    const proxies = [
      new Proxy({ results: [] }, { get: () => { throw new TypeError("GET_TRAP"); } }),
      new Proxy({ results: [] }, { getPrototypeOf: () => { throw new TypeError("PROTOTYPE_TRAP"); } }),
      new Proxy({ results: [] }, { ownKeys: () => { throw new TypeError("KEYS_TRAP"); } }),
      new Proxy({ results: [] }, { getOwnPropertyDescriptor: () => { throw new TypeError("DESCRIPTOR_TRAP"); } }),
      new Proxy({ results: [] }, { has: () => { throw new TypeError("HAS_TRAP"); } }),
    ];
    const revoked = Proxy.revocable({ results: [] }, {});
    revoked.revoke();
    const values: readonly unknown[] = [
      nullPrototype,
      customPrototype,
      accessor,
      hidden,
      symbol,
      sparse,
      new Date("2026-08-28T00:00:00.000Z"),
      new Map([["key", "value"]]),
      new Set(["value"]),
      ...proxies,
      revoked.proxy,
    ];

    for (const value of values) expectProviderInvalid(await reader(value).search("fixture"));
  });

  it("counts each JSON value node once at the exact 4096 and 4097 boundaries", async () => {
    const exact = Object.fromEntries(Array.from({ length: 4_095 }, (_, index) => [`k${index}`, null]));
    const over = Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [`k${index}`, null]));
    const sharedAccepted = Object.fromEntries(Array.from({ length: 2_046 }, (_, index) => [`k${index}`, null]));
    const sharedRejected = Object.fromEntries(Array.from({ length: 2_047 }, (_, index) => [`k${index}`, null]));
    let depth64: unknown = null;
    let depth65: unknown = null;
    for (let depth = 0; depth < 64; depth += 1) depth64 = { next: depth64 };
    for (let depth = 0; depth < 65; depth += 1) depth65 = { next: depth65 };

    const accepted = await reader(exact).search("fixture");
    const rejected = await reader(over).search("fixture");
    const dagAccepted = await reader({ left: sharedAccepted, right: sharedAccepted }).search("fixture");
    const dagRejected = await reader({ left: sharedRejected, right: sharedRejected }).search("fixture");
    const depthAccepted = await reader(depth64).search("fixture");
    const depthRejected = await reader(depth65).search("fixture");

    expect(accepted).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_SEARCH_MALFORMED",
      checked_at: NOW.toISOString(),
    });
    expect(dagAccepted).toEqual(accepted);
    expect(depthAccepted).toEqual(accepted);
    expectProviderInvalid(rejected);
    expectProviderInvalid(dagRejected);
    expectProviderInvalid(depthRejected);
  });
});
