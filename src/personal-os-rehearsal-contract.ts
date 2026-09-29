import { z } from "zod";
import { DASHBOARD_RUNTIME_PORT } from "./dashboard-runtime-config.js";
import { PersonalOsError } from "./personal-os-errors.js";
import {
  PHONE_GATEWAY_PORT,
  PHONE_GATEWAY_TARGET,
  PHONE_PUBLIC_HTTPS_PORT,
  PHONE_SERVE_HTTPS_FLAG,
} from "./phone-gateway-protocol.js";

export const REHEARSAL_OK = "PERSONAL_OS_REHEARSAL_OK" as const;
export const SCENARIO_OK = "PERSONAL_OS_REHEARSAL_SCENARIO_OK" as const;
export const FORGOTTEN_SENTINEL = "TASK36-FORGOTTEN-SENTINEL" as const;
export const PROVIDER_WHEEL_SHA256 =
  "dcffa57bd011d59f0993583fee435413ebb0fb293fb3de941b567cca8e70e762" as const;
export const PROVIDER_SOURCE_COMMIT = "7336527bb1040c42b5ae5c33136f22ea33abb88b" as const;
export const PROVIDER_SOURCE_DEFAULT = "/home/jm/orca/workspaces/second-brain-app/task-30-b3b" as const;

export const REHEARSAL_SCENARIOS = [
  "second-brain-no-data",
  "second-brain-offline",
  "mac-disconnected",
  "schema-incompatible-rollback",
  "jm-server-offline",
  "crash-after-dispatch",
  "lost-memory-response",
  "expired-passkey",
  "delete-sentinel",
  "restore-tombstone",
  "rollback",
] as const;
export type RehearsalScenario = (typeof REHEARSAL_SCENARIOS)[number];

/** Linux endpoints the orchestrator's Mac and phone QA steps target. This worker does not run them. */
export const CLIENT_QA_TARGETS = {
  scope: "orchestrator",
  mac_electron_qa: "not_in_worker_scope",
  phone_browser_qa: "not_in_worker_scope",
  linux_dashboard: `http://127.0.0.1:${DASHBOARD_RUNTIME_PORT}`,
  linux_phone_gateway: PHONE_GATEWAY_TARGET,
  linux_phone_gateway_port: PHONE_GATEWAY_PORT,
  tailscale_serve: `tailscale serve --bg ${PHONE_SERVE_HTTPS_FLAG} ${PHONE_GATEWAY_TARGET}`,
  tailscale_https_port: PHONE_PUBLIC_HTTPS_PORT,
  authority_identity: "linux-authority",
  provider_identity: "linux-second-brain",
  mac_client_identity: "mac-client",
  phone_client_identity: "phone-browser",
  funnel: false,
} as const;

export type RehearsalEvents = {
  readonly unauthorized: number;
  readonly duplicate: number;
  readonly stale_authoritative: number;
  readonly deletion_leak: number;
};

export const ZERO_EVENTS: RehearsalEvents = {
  unauthorized: 0,
  duplicate: 0,
  stale_authoritative: 0,
  deletion_leak: 0,
};

export type TypedUnavailable = {
  readonly state: "unavailable";
  readonly capability: string;
  readonly reason: string;
};

export type RehearsalStage = {
  readonly name: string;
  readonly ok: boolean;
  readonly actual: unknown;
};

const HEX40 = /^[0-9a-f]{40}$/;
export const FixtureSchema = z.object({
  schema_version: z.literal(1),
  scenario: z.string().min(1),
  commit: z.string().regex(HEX40),
  tree: z.string().regex(HEX40),
  first_parent: z.string().regex(HEX40),
  subject: z.string().min(1),
  commit_timestamp: z.string().min(1),
  provider_commit: z.string().regex(HEX40),
  provider_tree: z.string().regex(HEX40),
  provider_first_parent: z.string().regex(HEX40),
  provider_subject: z.string().min(1),
});
export type RehearsalFixture = z.infer<typeof FixtureSchema>;

const CLOCK = /^(\d{4}-\d{2}-\d{2})T07:15:00([+-]\d{2}:\d{2})$/;

export function parseRehearsalClock(clock: string): {
  readonly anchor_at: string;
  readonly virtual_at: string;
  readonly at: Date;
} {
  const match = CLOCK.exec(clock);
  const date = match?.[1];
  const offset = match?.[2];
  if (date === undefined || offset === undefined) throw new PersonalOsError("E_CLOCK_INVALID");
  const at = new Date(`${date}T07:15:00${offset}`);
  if (!Number.isFinite(at.getTime())) throw new PersonalOsError("E_CLOCK_INVALID");
  return {
    anchor_at: at.toISOString(),
    virtual_at: new Date(`${date}T06:55:00${offset}`).toISOString(),
    at,
  };
}

export function isRehearsalScenario(value: string): value is RehearsalScenario {
  return (REHEARSAL_SCENARIOS as readonly string[]).includes(value);
}

export function unavailable(capability: string, reason: string): TypedUnavailable {
  return { state: "unavailable", capability, reason };
}

export type RehearsalOptions = {
  readonly fixturePath: string;
  readonly clock: string;
  readonly releaseRoot: string;
  readonly sourceRoot?: string;
  readonly scenario?: string;
};

export function stageResult(name: string, ok: boolean, actual: unknown): RehearsalStage {
  return { name, ok, actual };
}
