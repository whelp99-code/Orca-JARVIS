import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthorityDb } from "./db.js";
import type { DailyProductionPolicy } from "./daily-loop-morning-execution.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";
import { secondBrainLauncher } from "./second-brain-endpoint.js";

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
  // The endpoint is resolved the way every other consumer resolves it: the configured deployment
  // roots, which JARVIS_SECOND_BRAIN_LAUNCHER/CONFIG override. Gating on that override being *set*
  // made the shipped default unreachable, so the installed unit could only ever withhold - and a
  // deployment that has the provider installed did ask for it.
  //
  // A deployment that names no memory provider is still not a broken one: it produces nothing that
  // rests on a memory and still publishes what is already on record. That answer now belongs to a
  // launcher that is not installed, which is what "this host never asked for one" looks like on
  // disk, rather than to an empty environment on a host that ships the provider.
  if (!existsSync(process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] ?? secondBrainLauncher())) {
    return { policy, policy_decision_ref: decisionRef };
  }
  let runtime: ReturnType<typeof createProductionMemoryReference> | undefined;
  try {
    // Constructing the runtime is inside the same guard as the read: an unreadable projection key
    // withholds the memory too. The default endpoint is now reachable on every deployment that
    // installed the provider, and failing the whole morning over one unavailable input would be
    // worse than the abstention the run already knows how to report.
    runtime = createProductionMemoryReference(db, { clock });
    // A successful read has already awaited the transport shutdown before its final check.
    const reference = await runtime.reader.read("What should happen next?",
      { max_records: 8, max_record_bytes: 4_096, max_bytes: 32_768 }, runtime.close);
    return { policy, policy_decision_ref: decisionRef, memory_reference: reference };
  } catch {
    // An unavailable or refused provider withholds the memory, and the run reports that as an
    // abstention. Failing the whole morning because a read did not come back would be worse.
    await runtime?.close().catch(() => undefined);
    return { policy, policy_decision_ref: decisionRef };
  }
}
