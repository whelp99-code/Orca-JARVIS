import { controlValueDigest } from "./control-plane-contract.js";
import { JarvisError } from "./db.js";

/** Approval-required kinds. Low-risk work never reaches this validator. */
export const EXTERNAL_DELEGATE_APPROVAL_KINDS = Object.freeze([
  "mail.send", "notion.write", "tax.transmit", "payment",
] as const);

export const EXTERNAL_DELEGATE_NOTION_EFFECTS = Object.freeze([
  "create", "delete", "amount", "date", "status", "partner",
] as const);

export const EXTERNAL_DELEGATE_MAX_ITEMS = 50;
export const EXTERNAL_DELEGATE_RECEIPT_WINDOW_MS = 30 * 60_000;

/** Token file identity → inbox row. Never taken from the request body. */
export const EXTERNAL_DELEGATE_REQUESTERS = Object.freeze({
  "agent:grok-bot": { source: "grok-bot", system: "grok-bot", header: "윤비서 요청" },
  "agent:omonyang": { source: "omonyang", system: "omonyang", header: "오모냥 요청" },
} as const);

export type ExternalDelegateRequester = keyof typeof EXTERNAL_DELEGATE_REQUESTERS;

export function externalDelegateRequester(id: string): (typeof EXTERNAL_DELEGATE_REQUESTERS)[ExternalDelegateRequester] | undefined {
  if (!Object.hasOwn(EXTERNAL_DELEGATE_REQUESTERS, id)) return undefined;
  return EXTERNAL_DELEGATE_REQUESTERS[id as ExternalDelegateRequester];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExternalDelegateItem = Readonly<{
  action_kind: string;
  summary: string;
  payload_digest: string;
  mail_draft_id?: string;
  notion_effect?: string;
}>;

export function externalDelegateBatchDigest(items: readonly ExternalDelegateItem[]): string {
  return controlValueDigest(items.map(canonicalItem));
}

export function parseExternalDelegateItems(value: unknown): readonly ExternalDelegateItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXTERNAL_DELEGATE_MAX_ITEMS) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
  const items = value.map(parseItem);
  const digests = items.map(item => item.payload_digest);
  if (new Set(digests).size !== digests.length) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  return items;
}

function parseItem(value: unknown): ExternalDelegateItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  const row = value as Record<string, unknown>;
  const allowed = new Set(["action_kind", "summary", "payload_digest", "mail_draft_id", "notion_effect"]);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  const action = row.action_kind;
  const summary = row.summary;
  const digest = row.payload_digest;
  if (typeof action !== "string" || !(EXTERNAL_DELEGATE_APPROVAL_KINDS as readonly string[]).includes(action)) {
    throw new JarvisError("CONTROL_ARGS_MISMATCH");
  }
  if (typeof summary !== "string" || summary.length < 1 || summary.length > 240) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  const item: ExternalDelegateItem = { action_kind: action, summary, payload_digest: digest };
  if (action === "mail.send") {
    const id = row.mail_draft_id;
    if (typeof id !== "string" || !UUID.test(id)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
    return { ...item, mail_draft_id: id };
  }
  if ("mail_draft_id" in row) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  if (action === "notion.write") {
    const effect = row.notion_effect;
    if (typeof effect !== "string" || !(EXTERNAL_DELEGATE_NOTION_EFFECTS as readonly string[]).includes(effect)) {
      throw new JarvisError("CONTROL_ARGS_MISMATCH");
    }
    return { ...item, notion_effect: effect };
  }
  if ("notion_effect" in row) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  return item;
}

function canonicalItem(item: ExternalDelegateItem): Record<string, string> {
  return {
    action_kind: item.action_kind,
    summary: item.summary,
    payload_digest: item.payload_digest,
    ...(item.mail_draft_id ? { mail_draft_id: item.mail_draft_id } : {}),
    ...(item.notion_effect ? { notion_effect: item.notion_effect } : {}),
  };
}
