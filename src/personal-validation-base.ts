import { canonicalize } from "./canonical.js";
import {
  PERSONAL_CONTRACT_VERSION,
  PERSONAL_CONTRACT_VERSION_UNSUPPORTED,
  PERSONAL_MAX_LIFETIME_MS,
  PERSONAL_TOTAL_BYTES_MAX,
  type PersonalContractV1,
  type PersonalEnvelopeV1,
} from "./personal-contracts.js";
import {
  PersonalContractError,
  invalid,
  ENVELOPE_KEYS,
  record,
  closed,
  timestamp,
  correlation,
  idempotency,
  list,
  markParsedContract,
  type ParsedBase,
  type IdParser,
} from "./personal-validation-primitives.js";
import { parseSource, parseAuthority, parseFreshness, parsePolicy, parseEvidence } from "./personal-validation-metadata.js";

export function parseBase<Id>(value: unknown, parseId: IdParser<Id>): { readonly input: Record<string, unknown>; readonly base: ParsedBase<Id> } {
  const input = record(value);
  if (input.schema_version !== PERSONAL_CONTRACT_VERSION) throw new PersonalContractError(PERSONAL_CONTRACT_VERSION_UNSUPPORTED);
  closed(input, ENVELOPE_KEYS);
  const created = timestamp(input.created_at);
  const observed = timestamp(input.observed_at);
  const valid = timestamp(input.valid_at);
  const expires = timestamp(input.expires_at);
  const fresh = parseFreshness(input.freshness);
  const source = parseSource(input.source);
  const evidence = list(input.evidence, parseEvidence);
  const createdMs = Date.parse(created);
  if (
    Date.parse(observed) > createdMs ||
    Date.parse(valid) > createdMs ||
    Date.parse(fresh.checked_at) < Date.parse(observed) ||
    Date.parse(fresh.fresh_until) < Date.parse(fresh.checked_at) ||
    Date.parse(fresh.fresh_until) >= Date.parse(expires) ||
    Date.parse(expires) <= createdMs ||
    Date.parse(expires) - createdMs > PERSONAL_MAX_LIFETIME_MS ||
    evidence.some((item) => Date.parse(item.observed_at) > createdMs)
  )
    invalid();
  return {
    input,
    base: {
      schema_version: PERSONAL_CONTRACT_VERSION,
      id: parseId(input.id),
      created_at: created,
      observed_at: observed,
      valid_at: valid,
      source,
      authority: parseAuthority(input.authority),
      freshness: fresh,
      expires_at: expires,
      idempotency_key: idempotency(input.idempotency_key),
      correlation_id: correlation(input.correlation_id),
      causation_id: input.causation_id === null ? null : correlation(input.causation_id),
      policy_decision: parsePolicy(input.policy_decision),
      evidence,
    },
  };
}
export function finish<T extends PersonalContractV1>(value: T): T {
  if (Buffer.byteLength(canonicalize(value), "utf8") > PERSONAL_TOTAL_BYTES_MAX) invalid();
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const key of Reflect.ownKeys(item)) freeze(Reflect.get(item, key));
    Object.freeze(item);
  };
  freeze(value);
  markParsedContract(value);
  return value;
}
export function nullableFamilyId<Id>(value: unknown, parse: IdParser<Id>): Id | null {
  return value === null ? null : parse(value);
}
export function common<Id, Payload, Receipt>(base: ParsedBase<Id>, payload: Payload, receipt: Receipt): PersonalEnvelopeV1<Id, Payload, Receipt> {
  return { ...base, payload, receipt };
}
