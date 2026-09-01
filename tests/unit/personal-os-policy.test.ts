import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatePersonalOsPolicy, parsePersonalOsPolicy, PersonalPolicyError } from "../../src/personal-os-policy.js";

const fixture = () => ({
  schema_version: 1,
  policy_id: "personal-os-policy-v1",
  owner_principal: "principal:owner",
  authority_host: "linux-control-plane",
  effective_at: "2026-08-28T00:00:00.000Z",
  expires_at: "2027-08-28T00:00:00.000Z",
  purposes: ["personal_memory", "live_awareness", "owner_notification", "data_portability", "data_erasure", "vault_migration", "disaster_recovery"],
  sensitivity_tiers: ["public", "personal", "sensitive", "restricted"],
  actions: ["memory", "observation", "notification", "export", "delete", "transfer", "restore"],
  retention: { max_days: 3650 },
  quiet_hours: { start: "22:00", end: "23:59", timezone: "UTC", critical_alert_classes: ["authority_expiry", "security_incident"] },
  prohibited_fields: ["secret", "raw_body", "raw_screen", "audio", "video"],
  notification_allowed_fields: ["title", "summary", "alert_class", "deep_link"],
  client_hosts: ["mac-client", "phone-client"],
  gates: {
    mac_vault_transfer: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL",
    linux_restore: "SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL",
    export: "PERSONAL_DATA_EXPORT_APPROVAL",
    deletion: "PERSONAL_DATA_DELETE_APPROVAL",
    sensitive_memory: "PERSONAL_MEMORY_CONFIRMATION",
  },
  data_classes: {
    memory: { purpose: "personal_memory", retention_days: 3650, confirmation: "sensitive", export: "exact_confirmation", deletion: "exact_confirmation", host_owner: "linux-second-brain", no_data: "abstain", transfer: "exact_gate", restore: "exact_gate", client_projection: "redacted" },
    observation: { purpose: "live_awareness", retention_days: 30, confirmation: "none", export: "allowed", deletion: "exact_confirmation", host_owner: "linux-control-plane", no_data: "abstain", transfer: "prohibited", restore: "prohibited", client_projection: "redacted" },
    notification: { purpose: "owner_notification", retention_days: 7, confirmation: "none", export: "allowed", deletion: "allowed", host_owner: "linux-control-plane", no_data: "abstain", transfer: "prohibited", restore: "prohibited", client_projection: "redacted" },
    export: { purpose: "data_portability", retention_days: 1, confirmation: "exact", export: "exact_confirmation", deletion: "allowed", host_owner: "linux-control-plane", no_data: "abstain", transfer: "prohibited", restore: "prohibited", client_projection: "metadata_only" },
    delete: { purpose: "data_erasure", retention_days: 30, confirmation: "exact", export: "prohibited", deletion: "exact_confirmation", host_owner: "linux-control-plane", no_data: "abstain", transfer: "prohibited", restore: "prohibited", client_projection: "metadata_only" },
    transfer: { purpose: "vault_migration", retention_days: 1, confirmation: "exact", export: "prohibited", deletion: "allowed", host_owner: "linux-second-brain", no_data: "abstain", transfer: "exact_gate", restore: "prohibited", client_projection: "prohibited" },
    restore: { purpose: "disaster_recovery", retention_days: 30, confirmation: "exact", export: "prohibited", deletion: "allowed", host_owner: "linux-second-brain", no_data: "abstain", transfer: "prohibited", restore: "exact_gate", client_projection: "prohibited" },
  },
  remote_approval: {
    schema_version: 1,
    allowed_actions: ["workflow.start", "workflow.advance", "workflow.cancel", "runbook.execute", "state.project", "evidence.negative.record"],
    max_action_level: 3, begin_ttl_seconds: 600, registration_ttl_seconds: 300, challenge_ttl_seconds: 300,
    activation_ttl_seconds: 600, pending_credential_ttl_seconds: 600, verification_reservation_ttl_seconds: 30,
    ingress_nonce_ttl_seconds: 30, audit_retention_days: 365, active_credential_cap: 5, pending_credential_cap: 2,
    live_registration_cap: 8, live_challenge_cap: 128, live_ingress_nonce_cap: 1024,
    counter_regression_policy: "reject_audit_local_owner_revoke",
    credential_tombstone_retention: "indefinite_security_identifier",
  },
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) throw new TypeError("fixture must be an object");
  return value;
};

const parseFailure = (mutate: (value: Record<string, unknown>) => void): string | undefined => {
  const value = object(structuredClone(fixture()));
  mutate(value);
  try {
    parsePersonalOsPolicy(value);
  } catch (error) {
    if (error instanceof PersonalPolicyError) return error.code;
    throw error;
  }
  return undefined;
};

describe("personal OS policy parser", () => {
  it("parses the shipped policy as a closed, bounded policy", () => {
    const value: unknown = JSON.parse(readFileSync("config/personal-os-policy.json", "utf8"));
    expect(parsePersonalOsPolicy(value)).toMatchObject({ schema_version: 1, owner_principal: "principal:owner" });
  });

  it.each([
    ["unknown sensitivity", (value: Record<string, unknown>) => { value.sensitivity_tiers = ["public", "unknown"]; }],
    ["unknown action", (value: Record<string, unknown>) => { value.actions = ["memory", "execute"]; }],
    ["malformed quiet window", (value: Record<string, unknown>) => { object(value.quiet_hours).start = "25:00"; }],
    ["wraparound quiet window", (value: Record<string, unknown>) => { object(value.quiet_hours).start = "22:00"; object(value.quiet_hours).end = "07:00"; }],
    ["empty quiet window", (value: Record<string, unknown>) => { object(value.quiet_hours).start = "22:00"; object(value.quiet_hours).end = "22:00"; }],
    ["indefinite retention", (value: Record<string, unknown>) => { object(object(value.data_classes).memory).retention_days = null; }],
    ["missing purpose", (value: Record<string, unknown>) => { delete object(object(value.data_classes).memory).purpose; }],
    ["missing owner", (value: Record<string, unknown>) => { delete value.owner_principal; }],
    ["prohibited notification field", (value: Record<string, unknown>) => { value.notification_allowed_fields = ["title", "secret"]; }],
    ["unknown version", (value: Record<string, unknown>) => { value.schema_version = 2; }],
    ["unknown key", (value: Record<string, unknown>) => { value.model_override = true; }],
    ["contradictory host owner", (value: Record<string, unknown>) => { object(object(value.data_classes).memory).host_owner = "mac-client"; }],
  ])("rejects %s", (_name, mutate) => {
    expect(parseFailure(mutate)).toBe("PERSONAL_POLICY_INVALID");
  });

  it.each(["mac_vault_transfer", "linux_restore", "export", "deletion", "sensitive_memory"])("rejects a noncanonical %s gate", gate => {
    expect(parseFailure(value => { object(value.gates)[gate] = "SHARED_UNTRUSTED_GATE"; })).toBe("PERSONAL_POLICY_INVALID");
  });

  it("rejects collapsed transfer and restore gates", () => {
    expect(parseFailure(value => { object(value.gates).linux_restore = "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL"; })).toBe("PERSONAL_POLICY_INVALID");
  });
});

describe("personal OS policy evaluator", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    action: "memory", data_class: "memory", principal_id: "principal:owner", purpose: "personal_memory", sensitivity: "personal",
    host: "linux-second-brain", client_host: null, observed_at: "2026-08-28T08:00:00.000Z", fresh_until: "2026-08-29T07:00:00.000Z", expires_at: "2026-08-29T08:00:00.000Z",
    payload_fields: ["summary"], alert_class: null, no_data: false, approval_id: null, content_origin: "trusted", requests_policy_mutation: false,
    requests_authority: false, ...overrides,
  });
  const decide = (overrides: Record<string, unknown> = {}, now = new Date("2026-08-28T12:00:00.000Z")) => evaluatePersonalOsPolicy(parsePersonalOsPolicy(fixture()), input(overrides), now);

  it("allows normal Linux memory and observation inputs", () => {
    expect(decide()).toEqual({ kind: "allow" });
    expect(decide({ action: "observation", data_class: "observation", purpose: "live_awareness", host: "linux-control-plane" })).toEqual({ kind: "allow" });
  });

  it("enforces critical-only quiet hours", () => {
    const notification = { action: "notification", data_class: "notification", purpose: "owner_notification", host: "linux-control-plane", payload_fields: ["title", "summary"], alert_class: "routine" };
    expect(decide(notification, new Date("2026-08-28T23:00:00.000Z"))).toEqual({ kind: "abstain", reason: "QUIET_HOURS" });
    expect(decide({ ...notification, alert_class: "security_incident" }, new Date("2026-08-28T23:00:00.000Z"))).toEqual({ kind: "allow" });
  });

  it.each(["secret", "raw_body", "raw_screen", "audio", "video"])("denies prohibited %s payloads before projection", field => {
    expect(decide({ payload_fields: [field], client_host: "mac-client" })).toEqual({ kind: "deny", reason: "PROHIBITED_PAYLOAD_FIELD" });
  });

  it("fails closed for wrong principals and stale policy or input", () => {
    expect(decide({ principal_id: "principal:other" })).toEqual({ kind: "deny", reason: "PRINCIPAL_MISMATCH" });
    expect(decide({ fresh_until: "2026-08-28T11:59:59.999Z" })).toEqual({ kind: "deny", reason: "INPUT_STALE" });
    expect(decide({ expires_at: "2026-08-28T11:59:59.999Z" })).toEqual({ kind: "deny", reason: "INPUT_EXPIRED" });
    expect(decide({ expires_at: "2036-08-28T08:00:00.000Z" })).toEqual({ kind: "deny", reason: "RETENTION_EXCEEDED" });
    expect(decide({}, new Date("2027-08-28T00:00:00.001Z"))).toEqual({ kind: "deny", reason: "POLICY_EXPIRED" });
  });

  it("keeps transfer and restore behind distinct confirmation even when the caller self-asserts approval", () => {
    expect(decide({ action: "transfer", data_class: "transfer", purpose: "vault_migration", approval_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL" })).toEqual({ kind: "require_confirmation", gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL" });
    expect(decide({ action: "restore", data_class: "restore", purpose: "disaster_recovery", approval_id: "SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL" })).toEqual({ kind: "require_confirmation", gate_id: "SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL" });
  });

  it("never treats caller-provided confirmation IDs as verified receipts", () => {
    expect(decide({ action: "export", data_class: "export", purpose: "data_portability", host: "linux-control-plane", approval_id: "PERSONAL_DATA_EXPORT_APPROVAL" })).toEqual({ kind: "require_confirmation", gate_id: "PERSONAL_DATA_EXPORT_APPROVAL" });
    expect(decide({ action: "delete", data_class: "delete", purpose: "data_erasure", host: "linux-control-plane", approval_id: "PERSONAL_DATA_DELETE_APPROVAL" })).toEqual({ kind: "require_confirmation", gate_id: "PERSONAL_DATA_DELETE_APPROVAL" });
    expect(decide({ sensitivity: "sensitive", approval_id: "PERSONAL_MEMORY_CONFIRMATION" })).toEqual({ kind: "require_confirmation", gate_id: "PERSONAL_MEMORY_CONFIRMATION" });
  });

  it("does not require an approval field in the evaluator input contract", () => {
    const { approval_id: ignored, ...request } = input();
    void ignored;
    expect(evaluatePersonalOsPolicy(parsePersonalOsPolicy(fixture()), request, new Date("2026-08-28T12:00:00.000Z"))).toEqual({ kind: "allow" });
  });

  it("abstains on no_data and redacts policy-approved client projections", () => {
    expect(decide({ no_data: true })).toEqual({ kind: "abstain", reason: "NO_DATA" });
    expect(decide({ client_host: "mac-client" })).toEqual({ kind: "redact", fields: ["summary"] });
  });

  it("denies retrieved policy mutation and memory authority escalation", () => {
    expect(decide({ content_origin: "retrieved", requests_policy_mutation: true })).toEqual({ kind: "deny", reason: "POLICY_MUTATION_ATTEMPT" });
    expect(decide({ content_origin: "model", requests_authority: true })).toEqual({ kind: "deny", reason: "AUTHORITY_ESCALATION_ATTEMPT" });
  });
});
