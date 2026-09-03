import { parseRemoteApprovalPolicy, RemoteApprovalPolicyError, type RemoteApprovalPolicy } from "./remote-approval-policy.js";
import {
  ACTIONS,
  CANONICAL_GATES,
  CLIENT_HOSTS,
  CLASS_KEYS,
  CONFIRMATIONS,
  HOSTS,
  MIGRATION,
  NOTIFICATION_FIELDS,
  PORTABILITY,
  PROHIBITED_FIELDS,
  PROJECTIONS,
  PURPOSES,
  SENSITIVITIES,
  type DataClassPolicy,
  type Host,
  type PersonalOsPolicy,
  type Purpose,
} from "./personal-os-policy-contract.js";
import {
  clockTime,
  closed,
  exactList,
  integer,
  invalid,
  literal,
  minutes,
  record,
  stringList,
  text,
  timestamp,
} from "./personal-os-policy-primitives.js";

function parseDataClass(value: unknown, purpose: Purpose, host: Host, maxDays: number): DataClassPolicy {
  const item = record(value);
  closed(item, CLASS_KEYS);
  const parsed: DataClassPolicy = {
    purpose: literal(item.purpose, PURPOSES),
    retention_days: integer(item.retention_days, 1, maxDays),
    confirmation: literal(item.confirmation, CONFIRMATIONS),
    export: literal(item.export, PORTABILITY),
    deletion: literal(item.deletion, PORTABILITY),
    host_owner: literal(item.host_owner, HOSTS),
    no_data: literal(item.no_data, ["abstain"] as const),
    transfer: literal(item.transfer, MIGRATION),
    restore: literal(item.restore, MIGRATION),
    client_projection: literal(item.client_projection, PROJECTIONS),
  };
  if (parsed.purpose !== purpose || parsed.host_owner !== host) invalid();
  return parsed;
}

export function parsePersonalOsPolicy(value: unknown): PersonalOsPolicy {
  const input = record(value);
  closed(input, [
    "schema_version",
    "policy_id",
    "owner_principal",
    "authority_host",
    "effective_at",
    "expires_at",
    "purposes",
    "sensitivity_tiers",
    "actions",
    "retention",
    "quiet_hours",
    "prohibited_fields",
    "notification_allowed_fields",
    "client_hosts",
    "gates",
    "data_classes",
    "remote_approval",
  ]);
  if (input.schema_version !== 1) invalid();
  exactList(input.purposes, PURPOSES);
  exactList(input.sensitivity_tiers, SENSITIVITIES);
  exactList(input.actions, ACTIONS);
  const retention = record(input.retention);
  closed(retention, ["max_days"]);
  const maxDays = integer(retention.max_days, 1, 3650);
  const quiet = record(input.quiet_hours);
  closed(quiet, ["start", "end", "timezone", "critical_alert_classes"]);
  const start = clockTime(quiet.start);
  const end = clockTime(quiet.end);
  if (quiet.timezone !== "UTC" || minutes(start) >= minutes(end)) invalid();
  const prohibited = exactList(input.prohibited_fields, PROHIBITED_FIELDS);
  const notificationFields = exactList(input.notification_allowed_fields, NOTIFICATION_FIELDS);
  const prohibitedSet = new Set<string>(prohibited);
  if (notificationFields.some((field) => prohibitedSet.has(field))) invalid();
  const gates = record(input.gates);
  closed(gates, ["mac_vault_transfer", "linux_restore", "export", "deletion", "sensitive_memory"]);
  const parsedGates = {
    mac_vault_transfer: literal(gates.mac_vault_transfer, [CANONICAL_GATES.mac_vault_transfer] as const),
    linux_restore: literal(gates.linux_restore, [CANONICAL_GATES.linux_restore] as const),
    export: literal(gates.export, [CANONICAL_GATES.export] as const),
    deletion: literal(gates.deletion, [CANONICAL_GATES.deletion] as const),
    sensitive_memory: literal(gates.sensitive_memory, [CANONICAL_GATES.sensitive_memory] as const),
  };
  if (new Set(Object.values(parsedGates)).size !== Object.keys(parsedGates).length) invalid();
  const classes = record(input.data_classes);
  closed(classes, ACTIONS);
  const dataClasses = {
    memory: parseDataClass(classes.memory, "personal_memory", "linux-second-brain", maxDays),
    observation: parseDataClass(classes.observation, "live_awareness", "linux-control-plane", maxDays),
    notification: parseDataClass(classes.notification, "owner_notification", "linux-control-plane", maxDays),
    export: parseDataClass(classes.export, "data_portability", "linux-control-plane", maxDays),
    delete: parseDataClass(classes.delete, "data_erasure", "linux-control-plane", maxDays),
    transfer: parseDataClass(classes.transfer, "vault_migration", "linux-second-brain", maxDays),
    restore: parseDataClass(classes.restore, "disaster_recovery", "linux-second-brain", maxDays),
  };
  if (
    dataClasses.memory.transfer !== "exact_gate" ||
    dataClasses.memory.restore !== "exact_gate" ||
    dataClasses.export.confirmation !== "exact" ||
    dataClasses.export.export !== "exact_confirmation" ||
    dataClasses.delete.confirmation !== "exact" ||
    dataClasses.delete.deletion !== "exact_confirmation" ||
    dataClasses.transfer.confirmation !== "exact" ||
    dataClasses.transfer.transfer !== "exact_gate" ||
    dataClasses.restore.confirmation !== "exact" ||
    dataClasses.restore.restore !== "exact_gate"
  )
    invalid();
  const effectiveAt = timestamp(input.effective_at);
  const expiresAt = timestamp(input.expires_at);
  if (Date.parse(effectiveAt) >= Date.parse(expiresAt) || Date.parse(expiresAt) - Date.parse(effectiveAt) > 366 * 86_400_000) invalid();
  let remoteApproval: RemoteApprovalPolicy;
  try {
    remoteApproval = parseRemoteApprovalPolicy(input.remote_approval);
  } catch (error) {
    if (error instanceof RemoteApprovalPolicyError) invalid();
    throw error;
  }
  return {
    schema_version: 1,
    policy_id: text(input.policy_id),
    owner_principal: text(input.owner_principal),
    authority_host: literal(input.authority_host, ["linux-control-plane"] as const),
    effective_at: effectiveAt,
    expires_at: expiresAt,
    retention: { max_days: maxDays },
    quiet_hours: { start, end, critical_alert_classes: stringList(quiet.critical_alert_classes) },
    prohibited_fields: prohibited,
    notification_allowed_fields: notificationFields,
    client_hosts: exactList(input.client_hosts, CLIENT_HOSTS),
    gates: parsedGates,
    data_classes: dataClasses,
    remote_approval: remoteApproval,
  };
}
