import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";

export const SECOND_BRAIN_PROVIDER_MAX_DEPTH = 64;
export const SECOND_BRAIN_PROVIDER_MAX_NODES = 4_096;
export const SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS = 16_384;

export function secondBrainUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type SecondBrainBudgetCode =
  | "SECOND_BRAIN_AGGREGATE_OVERSIZE"
  | "SECOND_BRAIN_PAGE_OVERSIZE"
  | "SECOND_BRAIN_PROVIDER_VALUE_INVALID";

type PendingValue =
  | { readonly kind: "visit"; readonly value: unknown; readonly depth: number }
  | { readonly kind: "leave"; readonly value: object };
type ProviderMeasurement = { readonly valueBytes: number; readonly jsonBytes: number };

/** Mutable request-local byte counter. Mutation is its sole purpose. */
export class SecondBrainReadBudget {
  private usedBytes = 0;

  constructor(private readonly limits: SecondBrainAdapterBudgets) {}

  consumeProvider(value: unknown, completePage = false): SecondBrainBudgetCode | undefined {
    const measured = this.measure(value);
    if (measured === undefined) return "SECOND_BRAIN_PROVIDER_VALUE_INVALID";
    if (completePage && measured.jsonBytes > this.limits.max_page_bytes) return "SECOND_BRAIN_PAGE_OVERSIZE";
    return this.consume(measured.valueBytes);
  }

  consumeReturned(value: unknown): SecondBrainBudgetCode | undefined {
    const measured = this.measure(value);
    return measured === undefined ? "SECOND_BRAIN_PROVIDER_VALUE_INVALID" : this.consume(measured.valueBytes);
  }

  private consume(bytes: number): SecondBrainBudgetCode | undefined {
    if (this.usedBytes + bytes > this.limits.max_total_bytes) return "SECOND_BRAIN_AGGREGATE_OVERSIZE";
    this.usedBytes += bytes;
    return undefined;
  }

  /** A node is the root, one object property value, or one array element value. */
  private measure(root: unknown): ProviderMeasurement | undefined {
    const pending: PendingValue[] = [{ kind: "visit", value: root, depth: 0 }];
    const active = new WeakSet<object>();
    let nodes = 0;
    let workItems = 0;
    let valueBytes = 0;
    let jsonBytes = 0;
    try {
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) return undefined;
        if (current.kind === "leave") {
          active.delete(current.value);
          continue;
        }
        nodes += 1;
        workItems += 1;
        if (current.depth > SECOND_BRAIN_PROVIDER_MAX_DEPTH || nodes > SECOND_BRAIN_PROVIDER_MAX_NODES
          || workItems > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return undefined;
        const scalar = this.measureScalar(current.value);
        if (scalar !== undefined) {
          valueBytes += scalar.valueBytes;
          jsonBytes += scalar.jsonBytes;
          continue;
        }
        if (typeof current.value !== "object" || current.value === null || active.has(current.value)) return undefined;
        active.add(current.value);
        pending.push({ kind: "leave", value: current.value });
        const measured = Array.isArray(current.value)
          ? this.measureArray(current.value, current.depth, pending)
          : this.measureObject(current.value, current.depth, pending);
        if (measured === undefined) return undefined;
        workItems += measured.workItems;
        if (workItems > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return undefined;
        valueBytes += measured.valueBytes;
        jsonBytes += measured.jsonBytes;
      }
    } catch (error) {
      if (error instanceof Error) return undefined;
      return undefined;
    }
    return { valueBytes, jsonBytes };
  }

  private measureScalar(value: unknown): ProviderMeasurement | undefined {
    if (value === null) return { valueBytes: 0, jsonBytes: 4 };
    if (typeof value === "string") {
      return { valueBytes: secondBrainUtf8Bytes(value), jsonBytes: secondBrainUtf8Bytes(JSON.stringify(value)) };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const encoded = JSON.stringify(value);
      return { valueBytes: secondBrainUtf8Bytes(encoded), jsonBytes: secondBrainUtf8Bytes(encoded) };
    }
    if (typeof value === "boolean") {
      const bytes = value ? 4 : 5;
      return { valueBytes: bytes, jsonBytes: bytes };
    }
    return undefined;
  }

  private measureArray(value: unknown[], depth: number, pending: PendingValue[]): (ProviderMeasurement & { readonly workItems: number }) | undefined {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return undefined;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      pending.push({ kind: "visit", value: descriptor.value, depth: depth + 1 });
    }
    return { workItems: 0, valueBytes: 0, jsonBytes: 2 + Math.max(0, value.length - 1) };
  }

  private measureObject(value: object, depth: number, pending: PendingValue[]): (ProviderMeasurement & { readonly workItems: number }) | undefined {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return undefined;
    let valueBytes = 0;
    let jsonBytes = 2 + Math.max(0, keys.length - 1);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      valueBytes += secondBrainUtf8Bytes(key);
      jsonBytes += secondBrainUtf8Bytes(JSON.stringify(key)) + 1;
      pending.push({ kind: "visit", value: descriptor.value, depth: depth + 1 });
    }
    return { workItems: keys.length, valueBytes, jsonBytes };
  }
}
