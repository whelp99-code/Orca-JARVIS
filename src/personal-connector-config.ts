import { AuthorityDb } from "./db.js";
import type { SecondBrainReadinessObservation } from "./second-brain-readiness.js";
import { PersonalConnectorConfigError } from "./personal-connector-types.js";
import type { SecondBrainOutcome, SecondBrainReadMethod } from "./second-brain-transport.js";
import type { SecondBrainConnectorRead } from "./personal-connector-second-brain-source.js";

export type ParsedPersonalConnectorConfig = {
  readonly clock: () => Date;
  readonly second_brain: {
    readonly call: (method: SecondBrainReadMethod, arguments_: Readonly<Record<string, unknown>>) => Promise<SecondBrainOutcome>;
    readonly readiness_inspect: () => Promise<SecondBrainReadinessObservation>;
    readonly budgets: { readonly max_hits: number; readonly max_excerpt_bytes: number; readonly max_total_bytes: number; readonly max_page_bytes: number };
    readonly max_age_ms: number;
    readonly expiry_ms: number;
    readonly operation: SecondBrainConnectorRead;
  };
  readonly orca: { readonly runner: (args: readonly string[]) => Promise<string>; readonly environment: string; readonly worktree: string };
  readonly timeline: { readonly authority: AuthorityDb; readonly limit: number };
  readonly portfolio: { readonly envelope: Buffer; readonly key: Buffer; readonly source: "local" | "jm-server"; readonly received_at: Date };
};

type Plain = Readonly<Record<string, unknown>>;
function fail(): never { throw new PersonalConnectorConfigError(); }
function record(value: unknown, keys: readonly string[]): Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return fail();
  for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor) || !descriptor.enumerable) return fail();
  const copy: Record<string, unknown> = {};
  for (const key of keys) copy[key] = descriptors[key]?.value;
  return Object.freeze(copy);
}
function clock(value: unknown): value is () => Date { return typeof value === "function"; }
function runner(value: unknown): value is (args: readonly string[]) => Promise<string> { return typeof value === "function"; }
function transportCall(value: unknown): value is ParsedPersonalConnectorConfig["second_brain"]["call"] {
  return typeof value === "function";
}
function readinessInspect(value: unknown): value is () => Promise<SecondBrainReadinessObservation> {
  return typeof value === "function";
}
function text(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u.test(value) ? value : fail();
}
function positive(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fail();
}
function operation(value: unknown): SecondBrainConnectorRead {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) return fail();
  const base = record(value, kindDescriptor.value === "conflicts" ? ["kind"]
    : kindDescriptor.value === "recent" ? ["days", "kind"]
      : kindDescriptor.value === "page" ? ["kind", "page_id"] : ["kind", "query"]);
  switch (base["kind"]) {
    case "search": return { kind: "search", query: text(base["query"]) };
    case "page": return { kind: "page", page_id: text(base["page_id"]) };
    case "recent": return { kind: "recent", days: positive(base["days"], 365) };
    case "conflicts": return { kind: "conflicts" };
    default: return fail();
  }
}

export function parsePersonalConnectorConfig(value: unknown): ParsedPersonalConnectorConfig {
  try {
    const top = record(value, ["clock", "orca", "portfolio", "second_brain", "timeline"]);
    const memory = record(top["second_brain"], [
      "budgets", "call", "expiry_ms", "max_age_ms", "operation", "readiness_inspect",
    ]);
    const budgets = record(memory["budgets"], ["max_excerpt_bytes", "max_hits", "max_page_bytes", "max_total_bytes"]);
    const orca = record(top["orca"], ["environment", "runner", "worktree"]);
    const timeline = record(top["timeline"], ["authority", "limit"]);
    const portfolio = record(top["portfolio"], ["envelope", "key", "received_at", "source"]);
    const authority = timeline["authority"];
    const envelope = portfolio["envelope"]; const key = portfolio["key"]; const receivedAt = portfolio["received_at"];
    if (!(authority instanceof AuthorityDb) || Object.getPrototypeOf(authority) !== AuthorityDb.prototype) return fail();
    if (!Buffer.isBuffer(envelope) || Object.getPrototypeOf(envelope) !== Buffer.prototype
      || !Buffer.isBuffer(key) || Object.getPrototypeOf(key) !== Buffer.prototype
      || !(receivedAt instanceof Date) || Object.getPrototypeOf(receivedAt) !== Date.prototype
      || !Number.isFinite(receivedAt.getTime())) return fail();
    const source = portfolio["source"];
    if (source !== "local" && source !== "jm-server") return fail();
    const call = memory["call"]; const inspect = memory["readiness_inspect"]; const run = orca["runner"]; const readClock = top["clock"];
    if (!transportCall(call) || !readinessInspect(inspect) || !runner(run) || !clock(readClock)) return fail();
    return Object.freeze({
      clock: readClock,
      second_brain: Object.freeze({
        call,
        readiness_inspect: inspect,
        budgets: Object.freeze({
          max_hits: positive(budgets["max_hits"], 32), max_excerpt_bytes: positive(budgets["max_excerpt_bytes"], 4_096),
          max_total_bytes: positive(budgets["max_total_bytes"], 65_536), max_page_bytes: positive(budgets["max_page_bytes"], 1_048_576),
        }),
        max_age_ms: positive(memory["max_age_ms"], 31 * 86_400_000),
        expiry_ms: positive(memory["expiry_ms"], 31 * 86_400_000), operation: operation(memory["operation"]),
      }),
      orca: Object.freeze({ runner: run, environment: text(orca["environment"]), worktree: text(orca["worktree"]) }),
      timeline: Object.freeze({ authority, limit: positive(timeline["limit"], 32) }),
      portfolio: Object.freeze({ envelope: Buffer.from(envelope), key: Buffer.from(key), source, received_at: new Date(receivedAt.getTime()) }),
    });
  } catch (error) {
    if (error instanceof PersonalConnectorConfigError) throw error;
    return fail();
  }
}
