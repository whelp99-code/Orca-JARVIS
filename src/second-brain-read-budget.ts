import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";

export function secondBrainUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type SecondBrainBudgetCode =
  | "SECOND_BRAIN_AGGREGATE_OVERSIZE"
  | "SECOND_BRAIN_PAGE_OVERSIZE"
  | "SECOND_BRAIN_PROVIDER_VALUE_INVALID";

/** Mutable request-local byte counter. Mutation is its sole purpose. */
export class SecondBrainReadBudget {
  private usedBytes = 0;

  constructor(private readonly limits: SecondBrainAdapterBudgets) {}

  consumeProvider(value: unknown, completePage = false): SecondBrainBudgetCode | undefined {
    if (completePage) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return "SECOND_BRAIN_PROVIDER_VALUE_INVALID";
      if (secondBrainUtf8Bytes(serialized) > this.limits.max_page_bytes) return "SECOND_BRAIN_PAGE_OVERSIZE";
    }
    return this.consume(value);
  }

  consumeReturned(value: unknown): SecondBrainBudgetCode | undefined {
    return this.consume(value);
  }

  private consume(value: unknown): SecondBrainBudgetCode | undefined {
    const bytes = this.valueBytes(value);
    if (bytes === undefined) return "SECOND_BRAIN_PROVIDER_VALUE_INVALID";
    if (this.usedBytes + bytes > this.limits.max_total_bytes) return "SECOND_BRAIN_AGGREGATE_OVERSIZE";
    this.usedBytes += bytes;
    return undefined;
  }

  private valueBytes(value: unknown): number | undefined {
    if (value === null) return 0;
    if (typeof value === "string") return secondBrainUtf8Bytes(value);
    if (typeof value === "number") return Number.isFinite(value) ? secondBrainUtf8Bytes(JSON.stringify(value)) : undefined;
    if (typeof value === "boolean") return value ? 4 : 5;
    if (Array.isArray(value)) return this.sum(value);
    if (typeof value !== "object") return undefined;
    return this.sum(Object.values(value));
  }

  private sum(values: readonly unknown[]): number | undefined {
    let total = 0;
    for (const value of values) {
      const bytes = this.valueBytes(value);
      if (bytes === undefined) return undefined;
      total += bytes;
    }
    return total;
  }
}
