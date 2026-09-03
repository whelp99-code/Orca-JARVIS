import {
  ACTIONS,
  CLIENT_HOSTS,
  EVALUATION_KEYS,
  EVALUATION_KEY_SET,
  HOSTS,
  ORIGINS,
  PURPOSES,
  SENSITIVITIES,
  type EvaluationInput,
  type PersonalOsPolicy,
  type PersonalPolicyDecision,
} from "./personal-os-policy-contract.js";
import {
  boolean,
  invalid,
  literal,
  minutes,
  nullableLiteral,
  nullableText,
  PersonalPolicyError,
  record,
  stringList,
  text,
  timestamp,
} from "./personal-os-policy-primitives.js";

function parseEvaluationInput(value: unknown): EvaluationInput {
  const input = record(value);
  const keys = Object.keys(input);
  if (EVALUATION_KEYS.some((key) => !(key in input)) || keys.some((key) => key !== "approval_id" && !EVALUATION_KEY_SET.has(key))) invalid();
  return {
    action: literal(input.action, ACTIONS),
    data_class: literal(input.data_class, ACTIONS),
    principal_id: text(input.principal_id),
    purpose: literal(input.purpose, PURPOSES),
    sensitivity: literal(input.sensitivity, SENSITIVITIES),
    host: literal(input.host, HOSTS),
    client_host: nullableLiteral(input.client_host, CLIENT_HOSTS),
    observed_at: timestamp(input.observed_at),
    fresh_until: timestamp(input.fresh_until),
    expires_at: timestamp(input.expires_at),
    payload_fields: stringList(input.payload_fields),
    alert_class: nullableText(input.alert_class),
    no_data: boolean(input.no_data),
    content_origin: literal(input.content_origin, ORIGINS),
    requests_policy_mutation: boolean(input.requests_policy_mutation),
    requests_authority: boolean(input.requests_authority),
  };
}

export function evaluatePersonalOsPolicy(policy: PersonalOsPolicy, value: unknown, now: Date): PersonalPolicyDecision {
  const time = now.getTime();
  if (time < Date.parse(policy.effective_at)) return { kind: "deny", reason: "POLICY_NOT_EFFECTIVE" };
  if (time > Date.parse(policy.expires_at)) return { kind: "deny", reason: "POLICY_EXPIRED" };
  let input: EvaluationInput;
  try {
    input = parseEvaluationInput(value);
  } catch (error) {
    if (error instanceof PersonalPolicyError) return { kind: "deny", reason: "MALFORMED_INPUT" };
    throw error;
  }
  const dataClass = policy.data_classes[input.data_class];
  if (input.principal_id !== policy.owner_principal) return { kind: "deny", reason: "PRINCIPAL_MISMATCH" };
  if (time > Date.parse(input.expires_at)) return { kind: "deny", reason: "INPUT_EXPIRED" };
  if (time > Date.parse(input.fresh_until)) return { kind: "deny", reason: "INPUT_STALE" };
  if (
    Date.parse(input.observed_at) > time ||
    Date.parse(input.observed_at) >= Date.parse(input.fresh_until) ||
    Date.parse(input.fresh_until) > Date.parse(input.expires_at)
  )
    return { kind: "deny", reason: "INPUT_TIME_INVALID" };
  if (Date.parse(input.expires_at) - Date.parse(input.observed_at) > dataClass.retention_days * 86_400_000)
    return { kind: "deny", reason: "RETENTION_EXCEEDED" };
  if (input.requests_policy_mutation) return { kind: "deny", reason: "POLICY_MUTATION_ATTEMPT" };
  if (input.requests_authority) return { kind: "deny", reason: "AUTHORITY_ESCALATION_ATTEMPT" };
  if (input.payload_fields.some((field) => policy.prohibited_fields.includes(field))) return { kind: "deny", reason: "PROHIBITED_PAYLOAD_FIELD" };
  if (input.action !== input.data_class) return { kind: "deny", reason: "DATA_CLASS_MISMATCH" };
  if (input.purpose !== dataClass.purpose) return { kind: "deny", reason: "PURPOSE_MISMATCH" };
  if (input.host !== dataClass.host_owner) return { kind: "deny", reason: "HOST_OWNER_MISMATCH" };
  if (input.no_data) return { kind: "abstain", reason: "NO_DATA" };
  let gate: string | null;
  switch (input.action) {
    case "transfer":
      gate = policy.gates.mac_vault_transfer;
      break;
    case "restore":
      gate = policy.gates.linux_restore;
      break;
    case "export":
      gate = policy.gates.export;
      break;
    case "delete":
      gate = policy.gates.deletion;
      break;
    case "memory":
      gate = input.sensitivity === "sensitive" || input.sensitivity === "restricted" ? policy.gates.sensitive_memory : null;
      break;
    case "observation":
    case "notification":
      gate = null;
      break;
    default: {
      const exhaustive: never = input.action;
      return exhaustive;
    }
  }
  if (gate !== null) return { kind: "require_confirmation", gate_id: gate };
  if (input.action === "notification") {
    if (input.payload_fields.some((field) => !policy.notification_allowed_fields.includes(field)))
      return { kind: "deny", reason: "NOTIFICATION_FIELD_NOT_ALLOWED" };
    const current = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (
      current >= minutes(policy.quiet_hours.start) &&
      current < minutes(policy.quiet_hours.end) &&
      (input.alert_class === null || !policy.quiet_hours.critical_alert_classes.includes(input.alert_class))
    )
      return { kind: "abstain", reason: "QUIET_HOURS" };
  }
  if (input.client_host !== null) {
    switch (dataClass.client_projection) {
      case "prohibited":
        return { kind: "deny", reason: "CLIENT_PROJECTION_PROHIBITED" };
      case "redacted":
      case "metadata_only":
        return { kind: "redact", fields: input.payload_fields };
      default: {
        const exhaustive: never = dataClass.client_projection;
        return exhaustive;
      }
    }
  }
  return { kind: "allow" };
}
