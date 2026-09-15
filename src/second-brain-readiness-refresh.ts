import { parseRefreshCompletion } from "./daily-loop-input.js";
import { SecondBrainRefreshReceiptReader } from "./second-brain-refresh-receipt.js";
import type { SecondBrainRefreshObservation } from "./second-brain-readiness.js";

/**
 * Where readiness looks for the provider's refresh receipt when no option names one.
 *
 * The provider release publishes the receipt at its own `refresh_receipt_path`; the daily loop is
 * handed that path in its configuration. Readiness has no configuration file of its own, so the
 * same absolute path is selected the way the provider endpoint already is -- by environment -- and
 * `--refresh-receipt` overrides it for a one-off probe.
 */
export const SECOND_BRAIN_RECEIPT_ENV = "JARVIS_SECOND_BRAIN_REFRESH_RECEIPT";

export function configuredRefreshReceiptPath(explicit?: string): string | undefined {
  const value = explicit ?? process.env[SECOND_BRAIN_RECEIPT_ENV];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The refresh the provider published, or nothing.
 *
 * Readiness could previously only see a refresh *attempt*: the provider's status line carries the
 * stage's `started_at`, never a completion, so `last_successful_refresh` stayed `missing` however
 * well the hourly refresh went. A published receipt is the completion evidence, and this reads it
 * through the same adapter and the same closed parser the daily loop uses -- `O_NOFOLLOW`, 8 KiB,
 * one frozen profile, an exact six-key receipt -- so readiness cannot accept a document the loop
 * would reject, or accept one from a release nobody negotiated with.
 *
 * Returning `undefined` is the honest answer for every refusal: absent, unreadable, a profile or
 * envelope this build never agreed to, or a protocol version it does not implement. The caller then
 * falls back to what the status line can prove, which is an attempt and not a completion.
 *
 * A capped or failed refresh is reported as exactly that. Neither is quietly promoted to a
 * completion: a clipped result is not an empty one, and "the last refresh failed" is a different
 * operational fact from "no refresh has ever run".
 */
export function secondBrainRefreshObservation(
  path: string | undefined,
): SecondBrainRefreshObservation | undefined {
  if (path === undefined) return undefined;
  const reader = new SecondBrainRefreshReceiptReader(path);
  let payload: unknown;
  try {
    payload = reader.read(new Date());
  } catch {
    // no-excuse-ok: catch -- an unreadable receipt is not evidence
    return undefined;
  }
  if (reader.lastOutcome().state !== "received") return undefined;
  let completion: ReturnType<typeof parseRefreshCompletion>;
  try {
    completion = parseRefreshCompletion(payload);
  } catch {
    // no-excuse-ok: catch -- a malformed receipt is not evidence
    return undefined;
  }
  if (completion === null || completion.protocol_version !== 1) return undefined;
  if (completion.state === "failed") return { kind: "failed", attempted_at: completion.completed_at };
  if (completion.capped) return { kind: "capped", attempted_at: completion.completed_at };
  return { kind: "success", completed_at: completion.completed_at };
}
