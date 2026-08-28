const PURPOSES = ["personal_memory", "live_awareness", "owner_notification", "data_portability", "data_erasure", "vault_migration", "disaster_recovery"] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const ACTIONS = ["memory", "observation", "notification", "export", "delete", "transfer", "restore"] as const;
const HOSTS = ["linux-control-plane", "linux-second-brain"] as const;
const CLIENT_HOSTS = ["mac-client", "phone-client"] as const;
const PROHIBITED_FIELDS = ["secret", "raw_body", "raw_screen", "audio", "video"] as const;
const NOTIFICATION_FIELDS = ["title", "summary", "alert_class", "deep_link"] as const;
const CONFIRMATIONS = ["none", "sensitive", "exact"] as const;
const PORTABILITY = ["allowed", "exact_confirmation", "prohibited"] as const;
const MIGRATION = ["prohibited", "exact_gate"] as const;
const PROJECTIONS = ["redacted", "metadata_only", "prohibited"] as const;
const ORIGINS = ["trusted", "retrieved", "model"] as const;
const CLASS_KEYS = ["purpose", "retention_days", "confirmation", "export", "deletion", "host_owner", "no_data", "transfer", "restore", "client_projection"] as const;

type Purpose = (typeof PURPOSES)[number];
type Sensitivity = (typeof SENSITIVITIES)[number];
type Action = (typeof ACTIONS)[number];
type Host = (typeof HOSTS)[number];
type ClientHost = (typeof CLIENT_HOSTS)[number];
type ContentOrigin = (typeof ORIGINS)[number];
type DataClassPolicy = {
  readonly purpose: Purpose;
  readonly retention_days: number;
  readonly confirmation: (typeof CONFIRMATIONS)[number];
  readonly export: (typeof PORTABILITY)[number];
  readonly deletion: (typeof PORTABILITY)[number];
  readonly host_owner: Host;
  readonly no_data: "abstain";
  readonly transfer: (typeof MIGRATION)[number];
  readonly restore: (typeof MIGRATION)[number];
  readonly client_projection: (typeof PROJECTIONS)[number];
};
type PersonalOsPolicy = {
  readonly schema_version: 1;
  readonly policy_id: string;
  readonly owner_principal: string;
  readonly authority_host: "linux-control-plane";
  readonly effective_at: string;
  readonly expires_at: string;
  readonly retention: { readonly max_days: number };
  readonly quiet_hours: { readonly start: string; readonly end: string; readonly critical_alert_classes: readonly string[] };
  readonly prohibited_fields: readonly string[];
  readonly notification_allowed_fields: readonly string[];
  readonly client_hosts: readonly ClientHost[];
  readonly gates: { readonly mac_vault_transfer: string; readonly linux_restore: string; readonly export: string; readonly deletion: string; readonly sensitive_memory: string };
  readonly data_classes: Readonly<Record<Action, DataClassPolicy>>;
};
type EvaluationInput = {
  readonly action: Action;
  readonly data_class: Action;
  readonly principal_id: string;
  readonly purpose: Purpose;
  readonly sensitivity: Sensitivity;
  readonly host: Host;
  readonly client_host: ClientHost | null;
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly expires_at: string;
  readonly payload_fields: readonly string[];
  readonly alert_class: string | null;
  readonly no_data: boolean;
  readonly approval_id: string | null;
  readonly content_origin: ContentOrigin;
  readonly requests_policy_mutation: boolean;
  readonly requests_authority: boolean;
};
export type PersonalPolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "require_confirmation"; readonly gate_id: string }
  | { readonly kind: "redact"; readonly fields: readonly string[] }
  | { readonly kind: "abstain"; readonly reason: string };

export class PersonalPolicyError extends Error {
  readonly name = "PersonalPolicyError";
  constructor(readonly code: "PERSONAL_POLICY_INVALID") { super(code); }
}

function invalid(): never { throw new PersonalPolicyError("PERSONAL_POLICY_INVALID"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value;
}
function closed(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) invalid();
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) return invalid();
  return value;
}
function literal<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] {
  if (typeof value !== "string") return invalid();
  const found = allowed.find(candidate => candidate === value);
  return found ?? invalid();
}
function exactList<const Values extends readonly string[]>(value: unknown, allowed: Values): readonly Values[number][] {
  if (!Array.isArray(value) || value.length !== allowed.length) return invalid();
  const parsed = value.map(item => literal(item, allowed));
  if (new Set(parsed).size !== allowed.length) return invalid();
  return parsed;
}
function stringList(value: unknown, maximum = 16): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return invalid();
  const parsed = value.map(text);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}
function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed) || new Date(parsed).toISOString() !== parsed) return invalid();
  return parsed;
}
function clockTime(value: unknown): string {
  const parsed = text(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed)) return invalid();
  return parsed;
}
function minutes(value: string): number {
  const [hours = "", minute = ""] = value.split(":");
  return Number(hours) * 60 + Number(minute);
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function nullableLiteral<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] | null {
  return value === null ? null : literal(value, allowed);
}

function parseDataClass(value: unknown, purpose: Purpose, host: Host, maxDays: number): DataClassPolicy {
  const item = record(value);
  closed(item, CLASS_KEYS);
  const parsed: DataClassPolicy = {
    purpose: literal(item.purpose, PURPOSES), retention_days: integer(item.retention_days, 1, maxDays), confirmation: literal(item.confirmation, CONFIRMATIONS),
    export: literal(item.export, PORTABILITY), deletion: literal(item.deletion, PORTABILITY), host_owner: literal(item.host_owner, HOSTS),
    no_data: literal(item.no_data, ["abstain"] as const), transfer: literal(item.transfer, MIGRATION), restore: literal(item.restore, MIGRATION),
    client_projection: literal(item.client_projection, PROJECTIONS),
  };
  if (parsed.purpose !== purpose || parsed.host_owner !== host) invalid();
  return parsed;
}

export function parsePersonalOsPolicy(value: unknown): PersonalOsPolicy {
  const input = record(value);
  closed(input, ["schema_version", "policy_id", "owner_principal", "authority_host", "effective_at", "expires_at", "purposes", "sensitivity_tiers", "actions", "retention", "quiet_hours", "prohibited_fields", "notification_allowed_fields", "client_hosts", "gates", "data_classes"]);
  if (input.schema_version !== 1) invalid();
  exactList(input.purposes, PURPOSES); exactList(input.sensitivity_tiers, SENSITIVITIES); exactList(input.actions, ACTIONS);
  const retention = record(input.retention); closed(retention, ["max_days"]); const maxDays = integer(retention.max_days, 1, 3650);
  const quiet = record(input.quiet_hours); closed(quiet, ["start", "end", "timezone", "critical_alert_classes"]);
  const start = clockTime(quiet.start); const end = clockTime(quiet.end);
  if (quiet.timezone !== "UTC" || minutes(start) >= minutes(end)) invalid();
  const prohibited = exactList(input.prohibited_fields, PROHIBITED_FIELDS);
  const notificationFields = exactList(input.notification_allowed_fields, NOTIFICATION_FIELDS);
  const prohibitedSet = new Set<string>(prohibited);
  if (notificationFields.some(field => prohibitedSet.has(field))) invalid();
  const gates = record(input.gates); closed(gates, ["mac_vault_transfer", "linux_restore", "export", "deletion", "sensitive_memory"]);
  const classes = record(input.data_classes); closed(classes, ACTIONS);
  const dataClasses = {
    memory: parseDataClass(classes.memory, "personal_memory", "linux-second-brain", maxDays), observation: parseDataClass(classes.observation, "live_awareness", "linux-control-plane", maxDays),
    notification: parseDataClass(classes.notification, "owner_notification", "linux-control-plane", maxDays), export: parseDataClass(classes.export, "data_portability", "linux-control-plane", maxDays),
    delete: parseDataClass(classes.delete, "data_erasure", "linux-control-plane", maxDays), transfer: parseDataClass(classes.transfer, "vault_migration", "linux-second-brain", maxDays),
    restore: parseDataClass(classes.restore, "disaster_recovery", "linux-second-brain", maxDays),
  };
  if (dataClasses.memory.transfer !== "exact_gate" || dataClasses.memory.restore !== "exact_gate" || dataClasses.export.confirmation !== "exact" || dataClasses.export.export !== "exact_confirmation" || dataClasses.delete.confirmation !== "exact" || dataClasses.delete.deletion !== "exact_confirmation" || dataClasses.transfer.confirmation !== "exact" || dataClasses.transfer.transfer !== "exact_gate" || dataClasses.restore.confirmation !== "exact" || dataClasses.restore.restore !== "exact_gate") invalid();
  const effectiveAt = timestamp(input.effective_at); const expiresAt = timestamp(input.expires_at);
  if (Date.parse(effectiveAt) >= Date.parse(expiresAt) || Date.parse(expiresAt) - Date.parse(effectiveAt) > 366 * 86_400_000) invalid();
  return { schema_version: 1, policy_id: text(input.policy_id), owner_principal: text(input.owner_principal), authority_host: literal(input.authority_host, ["linux-control-plane"] as const), effective_at: effectiveAt, expires_at: expiresAt,
    retention: { max_days: maxDays }, quiet_hours: { start, end, critical_alert_classes: stringList(quiet.critical_alert_classes) }, prohibited_fields: prohibited,
    notification_allowed_fields: notificationFields, client_hosts: exactList(input.client_hosts, CLIENT_HOSTS),
    gates: { mac_vault_transfer: text(gates.mac_vault_transfer), linux_restore: text(gates.linux_restore), export: text(gates.export), deletion: text(gates.deletion), sensitive_memory: text(gates.sensitive_memory) }, data_classes: dataClasses };
}

function parseEvaluationInput(value: unknown): EvaluationInput {
  const input = record(value);
  closed(input, ["action", "data_class", "principal_id", "purpose", "sensitivity", "host", "client_host", "observed_at", "fresh_until", "expires_at", "payload_fields", "alert_class", "no_data", "approval_id", "content_origin", "requests_policy_mutation", "requests_authority"]);
  return { action: literal(input.action, ACTIONS), data_class: literal(input.data_class, ACTIONS), principal_id: text(input.principal_id), purpose: literal(input.purpose, PURPOSES), sensitivity: literal(input.sensitivity, SENSITIVITIES), host: literal(input.host, HOSTS),
    client_host: nullableLiteral(input.client_host, CLIENT_HOSTS), observed_at: timestamp(input.observed_at), fresh_until: timestamp(input.fresh_until), expires_at: timestamp(input.expires_at), payload_fields: stringList(input.payload_fields),
    alert_class: nullableText(input.alert_class), no_data: boolean(input.no_data), approval_id: nullableText(input.approval_id), content_origin: literal(input.content_origin, ORIGINS), requests_policy_mutation: boolean(input.requests_policy_mutation), requests_authority: boolean(input.requests_authority) };
}

export function evaluatePersonalOsPolicy(policy: PersonalOsPolicy, value: unknown, now: Date): PersonalPolicyDecision {
  const time = now.getTime();
  if (time < Date.parse(policy.effective_at)) return { kind: "deny", reason: "POLICY_NOT_EFFECTIVE" };
  if (time > Date.parse(policy.expires_at)) return { kind: "deny", reason: "POLICY_EXPIRED" };
  let input: EvaluationInput;
  try { input = parseEvaluationInput(value); } catch (error) { if (error instanceof PersonalPolicyError) return { kind: "deny", reason: "MALFORMED_INPUT" }; throw error; }
  const dataClass = policy.data_classes[input.data_class];
  if (input.principal_id !== policy.owner_principal) return { kind: "deny", reason: "PRINCIPAL_MISMATCH" };
  if (time > Date.parse(input.expires_at)) return { kind: "deny", reason: "INPUT_EXPIRED" };
  if (time > Date.parse(input.fresh_until)) return { kind: "deny", reason: "INPUT_STALE" };
  if (Date.parse(input.observed_at) > time || Date.parse(input.observed_at) >= Date.parse(input.fresh_until) || Date.parse(input.fresh_until) > Date.parse(input.expires_at)) return { kind: "deny", reason: "INPUT_TIME_INVALID" };
  if (Date.parse(input.expires_at) - Date.parse(input.observed_at) > dataClass.retention_days * 86_400_000) return { kind: "deny", reason: "RETENTION_EXCEEDED" };
  if (input.requests_policy_mutation) return { kind: "deny", reason: "POLICY_MUTATION_ATTEMPT" };
  if (input.requests_authority) return { kind: "deny", reason: "AUTHORITY_ESCALATION_ATTEMPT" };
  if (input.payload_fields.some(field => policy.prohibited_fields.includes(field))) return { kind: "deny", reason: "PROHIBITED_PAYLOAD_FIELD" };
  if (input.action !== input.data_class) return { kind: "deny", reason: "DATA_CLASS_MISMATCH" };
  if (input.purpose !== dataClass.purpose) return { kind: "deny", reason: "PURPOSE_MISMATCH" };
  if (input.host !== dataClass.host_owner) return { kind: "deny", reason: "HOST_OWNER_MISMATCH" };
  if (input.no_data) return { kind: "abstain", reason: "NO_DATA" };
  let gate: string | null;
  switch (input.action) {
    case "transfer": gate = policy.gates.mac_vault_transfer; break;
    case "restore": gate = policy.gates.linux_restore; break;
    case "export": gate = policy.gates.export; break;
    case "delete": gate = policy.gates.deletion; break;
    case "memory": gate = input.sensitivity === "sensitive" || input.sensitivity === "restricted" ? policy.gates.sensitive_memory : null; break;
    case "observation": case "notification": gate = null; break;
    default: { const exhaustive: never = input.action; return exhaustive; }
  }
  if (gate !== null && input.approval_id !== gate) return { kind: "require_confirmation", gate_id: gate };
  if (input.action === "notification") {
    if (input.payload_fields.some(field => !policy.notification_allowed_fields.includes(field))) return { kind: "deny", reason: "NOTIFICATION_FIELD_NOT_ALLOWED" };
    const current = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (current >= minutes(policy.quiet_hours.start) && current < minutes(policy.quiet_hours.end) && (input.alert_class === null || !policy.quiet_hours.critical_alert_classes.includes(input.alert_class))) return { kind: "abstain", reason: "QUIET_HOURS" };
  }
  if (input.client_host !== null) {
    switch (dataClass.client_projection) {
      case "prohibited": return { kind: "deny", reason: "CLIENT_PROJECTION_PROHIBITED" };
      case "redacted": case "metadata_only": return { kind: "redact", fields: input.payload_fields };
      default: { const exhaustive: never = dataClass.client_projection; return exhaustive; }
    }
  }
  return { kind: "allow" };
}
