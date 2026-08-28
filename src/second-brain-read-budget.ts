import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";

export const SECOND_BRAIN_PROVIDER_MAX_DEPTH = 64;
export const SECOND_BRAIN_PROVIDER_MAX_NODES = 4_096;

export function secondBrainUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type SecondBrainBudgetCode =
  | "SECOND_BRAIN_AGGREGATE_OVERSIZE"
  | "SECOND_BRAIN_PAGE_OVERSIZE"
  | "SECOND_BRAIN_PROVIDER_VALUE_INVALID";

type PendingValue = { readonly value: unknown; readonly depth: number };
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

  private measure(root: unknown): ProviderMeasurement | undefined {
    const pending: PendingValue[] = [{ value: root, depth: 0 }];
    const seen = new WeakSet<object>();
    let nodes = 0;
    let valueBytes = 0;
    let jsonBytes = 0;
    try {
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || current.depth > SECOND_BRAIN_PROVIDER_MAX_DEPTH) return undefined;
        nodes += 1;
        if (nodes > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
        const scalar = this.measureScalar(current.value);
        if (scalar !== undefined) {
          valueBytes += scalar.valueBytes;
          jsonBytes += scalar.jsonBytes;
          continue;
        }
        if (typeof current.value !== "object" || current.value === null || seen.has(current.value)) return undefined;
        seen.add(current.value);
        const measured = Array.isArray(current.value)
          ? this.measureArray(current, pending, nodes)
          : this.measureObject(current, pending, nodes);
        if (measured === undefined) return undefined;
        nodes = measured.nodes;
        valueBytes += measured.valueBytes;
        jsonBytes += measured.jsonBytes;
      }
    } catch {
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

  private measureArray(
    current: PendingValue,
    pending: PendingValue[],
    nodes: number,
  ): (ProviderMeasurement & { readonly nodes: number }) | undefined {
    if (!Array.isArray(current.value) || Object.getPrototypeOf(current.value) !== Array.prototype
      || current.value.length > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
    const keys = Reflect.ownKeys(current.value);
    if (keys.length !== current.value.length + 1 || keys.some(key => typeof key !== "string")) return undefined;
    let measuredNodes = nodes;
    let valueBytes = 0;
    for (let index = 0; index < current.value.length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      measuredNodes += 1;
      if (measuredNodes > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
      valueBytes += secondBrainUtf8Bytes(key);
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    return {
      nodes: measuredNodes,
      valueBytes,
      jsonBytes: 2 + Math.max(0, current.value.length - 1),
    };
  }

  private measureObject(
    current: PendingValue,
    pending: PendingValue[],
    nodes: number,
  ): (ProviderMeasurement & { readonly nodes: number }) | undefined {
    if (typeof current.value !== "object" || current.value === null) return undefined;
    const prototype: unknown = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(current.value);
    if (keys.length > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
    let measuredNodes = nodes;
    let valueBytes = 0;
    let jsonBytes = 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      measuredNodes += 1;
      if (measuredNodes > SECOND_BRAIN_PROVIDER_MAX_NODES) return undefined;
      valueBytes += secondBrainUtf8Bytes(key);
      jsonBytes += secondBrainUtf8Bytes(JSON.stringify(key)) + 1;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    return { nodes: measuredNodes, valueBytes, jsonBytes };
  }
}
