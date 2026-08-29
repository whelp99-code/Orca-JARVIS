import { readFileSync } from "node:fs";

export const POLICY_CLOCK = "2026-08-28T12:00:00.000Z";

export function contextPolicyConfig(): unknown {
  return JSON.parse(readFileSync("config/personal-os-policy.json", "utf8"));
}

const fact = (
  ref: string,
  evidenceClass: "linux_live_fact" | "user_confirmed_principle" | "owner_decision",
  sourceHost: "linux-control-plane" | "linux-second-brain" | "mac-client",
) => ({
  kind: "evidence",
  ref,
  evidence_class: evidenceClass,
  source_host: sourceHost,
  state: "current",
  trust: "user_confirmed",
  relation: "supports",
  relates_to: evidenceClass === "linux_live_fact" ? null : "live:task:1",
  observed_at: "2026-08-28T11:30:00.000Z",
  valid_from: "2026-08-28T11:00:00.000Z",
  valid_until: "2026-08-28T13:00:00.000Z",
  fresh_until: "2026-08-28T12:30:00.000Z",
});

export function contextPolicyInput(): Readonly<Record<string, unknown>> {
  return {
    schema_version: 1,
    clock: POLICY_CLOCK,
    required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
    evidence: [
      fact("live:task:1", "linux_live_fact", "linux-control-plane"),
      fact("memory:principle:1", "user_confirmed_principle", "linux-second-brain"),
      fact("decision:owner:1", "owner_decision", "linux-control-plane"),
    ],
  };
}

export function contextPolicyFact(
  ref: string,
  evidenceClass: "linux_live_fact" | "user_confirmed_principle" | "owner_decision",
  sourceHost: "linux-control-plane" | "linux-second-brain" | "mac-client" = "linux-second-brain",
): Record<string, unknown> {
  return structuredClone(fact(ref, evidenceClass, sourceHost));
}
