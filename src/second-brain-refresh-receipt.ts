import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { RefreshCompletion, RefreshCompletionReader } from "./daily-loop-types.js";
import { parseBoundedStrictJson } from "./strict-json.js";

/**
 * The refresh receipt profile this build accepts.
 *
 * No provider publishes this yet: it is JARVIS's proposal, written down so the adapter can refuse
 * everything else by name instead of by silence. Until a provider release declares this exact
 * profile, every document is `unsupported` and the daily loop keeps reporting that it has no
 * refresh evidence. Adding a profile here is a contract change, not a configuration change.
 */
export const ACCEPTED_REFRESH_PROFILES = ["daily-refresh-receipt-v1"] as const;

export const REFRESH_RECEIPT_MAX_BYTES = 8192;

export type SecondBrainRefreshOutcome =
  | { readonly state: "unconfigured" }
  | { readonly state: "unreadable"; readonly reason: "absent" | "not_a_regular_file" | "too_large" }
  | { readonly state: "unsupported"; readonly reason: "profile" | "envelope";
      readonly declared: string | null }
  | { readonly state: "received"; readonly profile: string; readonly refresh_id: string };

type ReceiptEnvelope = {
  readonly schema_version: 1;
  readonly profile: string;
  readonly receipt: unknown;
};

/**
 * Reads one provider refresh receipt, or refuses to.
 *
 * The daily loop asks for a value and classifies it: absent evidence becomes `refresh_missing`, a
 * receipt whose protocol it does not support becomes `refresh_incompatible`, a capped or old one
 * becomes `refresh_capped` or `refresh_stale`. That classification is the product's, and this
 * adapter does not duplicate or pre-empt it. What it does is refuse to hand the loop anything that
 * did not come from a document declaring a profile this build froze, so a provider that publishes
 * nothing, publishes a different shape, or publishes a shape from an unnegotiated release can
 * never be read as a successful refresh.
 *
 * Every refusal is recorded with its reason, because "no refresh" and "a refresh this build cannot
 * accept" are different operational facts even though both leave the loop without evidence.
 */
export class SecondBrainRefreshReceiptReader implements RefreshCompletionReader {
  private outcome: SecondBrainRefreshOutcome = { state: "unconfigured" };

  constructor(private readonly receiptPath: string | undefined) {}

  /** The value the daily loop classifies: a receipt payload, or null when there is none. */
  read(at: Date): unknown {
    void at;
    this.outcome = { state: "unconfigured" };
    if (this.receiptPath === undefined) return null;
    const text = this.readBounded(this.receiptPath);
    if (text === undefined) return null;
    const envelope = this.parseEnvelope(text);
    if (envelope === undefined) return null;
    const receipt = envelope.receipt;
    const refreshId = receipt !== null && typeof receipt === "object"
      ? Reflect.get(receipt, "refresh_id") : undefined;
    this.outcome = { state: "received", profile: envelope.profile,
      refresh_id: typeof refreshId === "string" ? refreshId : "" };
    // Handed over exactly as published: the loop's own parser decides whether it is usable.
    return receipt;
  }

  /** Why the last read produced what it did. Diagnostics only; never an authority signal. */
  lastOutcome(): SecondBrainRefreshOutcome {
    return this.outcome;
  }

  private readBounded(path: string): string | undefined {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      this.outcome = { state: "unreadable", reason: "absent" };
      return undefined;
    }
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile()) {
        this.outcome = { state: "unreadable", reason: "not_a_regular_file" };
        return undefined;
      }
      if (metadata.size < 1 || metadata.size > REFRESH_RECEIPT_MAX_BYTES) {
        this.outcome = { state: "unreadable", reason: "too_large" };
        return undefined;
      }
      const buffer = Buffer.alloc(metadata.size);
      const read = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (read !== metadata.size) {
        this.outcome = { state: "unreadable", reason: "too_large" };
        return undefined;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      this.outcome = { state: "unreadable", reason: "not_a_regular_file" };
      return undefined;
    } finally {
      closeSync(descriptor);
    }
  }

  private parseEnvelope(text: string): ReceiptEnvelope | undefined {
    let value: unknown;
    try {
      value = parseBoundedStrictJson(text,
        { depth: 16, nodes: 512, workItems: 4096, characters: REFRESH_RECEIPT_MAX_BYTES });
    } catch {
      this.outcome = { state: "unsupported", reason: "envelope", declared: null };
      return undefined;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.outcome = { state: "unsupported", reason: "envelope", declared: null };
      return undefined;
    }
    const keys = Object.keys(value).sort();
    const profile = Reflect.get(value, "profile");
    const declared = typeof profile === "string" ? profile : null;
    if (keys.join(",") !== "profile,receipt,schema_version"
      || Reflect.get(value, "schema_version") !== 1 || declared === null) {
      this.outcome = { state: "unsupported", reason: "envelope", declared };
      return undefined;
    }
    if (!ACCEPTED_REFRESH_PROFILES.some(candidate => candidate === declared)) {
      this.outcome = { state: "unsupported", reason: "profile", declared };
      return undefined;
    }
    return { schema_version: 1, profile: declared, receipt: Reflect.get(value, "receipt") };
  }
}

export type { RefreshCompletion };
