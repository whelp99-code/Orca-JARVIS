import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthorityDb } from "./db.js";
import type { DailyProductionPolicy } from "./daily-loop-morning-execution.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";

/**
 * What the morning run may rest on when it produces, read from the policy document this deployment
 * ships. A deployment without one produces nothing rather than inventing a policy, and the run still
 * publishes whatever is already on record.
 *
 * Both morning surfaces derive this the same way and from the same configured sources - the
 * `daily morning --once` command and the configured service - because a deployment that can produce
 * when asked by hand and cannot produce when run as a service is one product with two answers.
 */
export async function dailyProductionPolicy(db: AuthorityDb, clock: () => Date): Promise<DailyProductionPolicy | undefined> {
  let policy: unknown;
  let decisionRef: string;
  try {
    policy = JSON.parse(readFileSync(resolve(process.cwd(), "config/personal-os-policy.json"), "utf8"));
    decisionRef = `policy:linux:${parsePersonalOsPolicy(policy).policy_id}:daily-morning`;
  } catch { return undefined; }
  // A deployment that names no memory provider is not a broken one: it produces nothing that rests
  // on a memory and still publishes what is already on record. Reaching for a default launcher path
  // here would start the operational provider on a host that never asked for it.
  if (process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] === undefined) {
    return { policy, policy_decision_ref: decisionRef };
  }
  const runtime = createProductionMemoryReference(db, { clock });
  try {
    // A successful read has already awaited the transport shutdown before its final check.
    const reference = await runtime.reader.read("What should happen next?",
      { max_records: 8, max_record_bytes: 4_096, max_bytes: 32_768 }, runtime.close);
    return { policy, policy_decision_ref: decisionRef, memory_reference: reference };
  } catch {
    // An unavailable or refused provider withholds the memory, and the run reports that as an
    // abstention. Failing the whole morning because a read did not come back would be worse.
    await runtime.close().catch(() => undefined);
    return { policy, policy_decision_ref: decisionRef };
  }
}
