import { JarvisError } from "../jarvis-error.js";
import { Core5CapabilityRegistry } from "./capability-registry.js";
import { cardStateFromMailDraft, mailReviewHref, type MailDraftCardState, type MailDraftObservation } from "./mail-draft-card.js";
import { Core5MailDraftStore, type MailDraftRef } from "./mail-draft-store.js";
import { Core5OperationLedger } from "./operation-ledger.js";
import type { CommandEnvelope } from "./types.js";

export type MailDraftHttp = {
  request(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
};

export type MailDraftCard = {
  readonly operation_id: string;
  readonly draft_id: string;
  readonly review_href: string;
  readonly mail_status: string;
  readonly card_state: MailDraftCardState | null;
  readonly owner_principal: "agent:jarvis";
};

const FORBIDDEN = Object.freeze(["/approve", "/cancel"]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JarvisError("CORE5_MAIL_RESPONSE_INVALID", "body");
  }
  return value as Record<string, unknown>;
}

function draftFrom(body: unknown): MailDraftObservation {
  const root = record(body);
  const draft = record(root["draft"] ?? root);
  const draft_id = draft["draft_id"];
  const status = draft["status"];
  if (typeof draft_id !== "string" || draft_id.length === 0) throw new JarvisError("CORE5_MAIL_RESPONSE_INVALID", "draft_id");
  if (typeof status !== "string" || status.length === 0) throw new JarvisError("CORE5_MAIL_RESPONSE_INVALID", "status");
  const owner = draft["owner_principal"];
  if (owner !== undefined && owner !== "agent:jarvis") throw new JarvisError("CORE5_MAIL_PRINCIPAL_INVALID", String(owner));
  const digest = draft["payload_digest"];
  const failure = draft["failure_reason"];
  const uncertain = draft["uncertain"];
  return {
    draft_id,
    status,
    ...(typeof owner === "string" ? { owner_principal: owner } : {}),
    ...(typeof digest === "string" ? { payload_digest: digest } : {}),
    ...(failure === undefined ? {} : { failure_reason: typeof failure === "string" ? failure : null }),
    ...(typeof uncertain === "boolean" ? { uncertain } : {}),
  };
}

export class Core5MailDraftGateway {
  constructor(
    private readonly registry: Core5CapabilityRegistry,
    private readonly ledger: Core5OperationLedger,
    private readonly store: Core5MailDraftStore,
    private readonly http: MailDraftHttp,
    private readonly mailOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(envelope: CommandEnvelope): Promise<MailDraftCard> {
    this.registry.requireEnabled("mail.draft");
    if (envelope.capability !== "mail.draft") throw new JarvisError("CORE5_CAPABILITY_UNKNOWN", envelope.capability);
    this.ledger.schedule(envelope);
    const response = await this.http.request({
      method: "POST",
      path: "/api/mail/send-drafts",
      body: envelope.payload,
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new JarvisError("CORE5_MAIL_DRAFT_REJECTED", String(response.status));
    }
    return this.persist(envelope.operation_id, draftFrom(response.body));
  }

  async refresh(operationId: string): Promise<MailDraftCard> {
    this.registry.requireEnabled("mail.status");
    const existing = this.store.get(operationId);
    if (existing === undefined) throw new JarvisError("CORE5_MAIL_REF_MISSING", operationId);
    const response = await this.http.request({
      method: "GET",
      path: `/api/mail/send-drafts/${existing.draft_id}`,
    });
    if (response.status !== 200) throw new JarvisError("CORE5_MAIL_DRAFT_REJECTED", String(response.status));
    return this.persist(operationId, draftFrom(response.body));
  }

  approve(): never {
    throw new JarvisError("CORE5_MAIL_HUMAN_OWNED", "approve");
  }

  send(): never {
    throw new JarvisError("CORE5_MAIL_HUMAN_OWNED", "send");
  }

  cancel(): never {
    throw new JarvisError("CORE5_MAIL_HUMAN_OWNED", "cancel");
  }

  assertHumanOwnedPath(path: string): void {
    for (const suffix of FORBIDDEN) {
      if (path.endsWith(suffix)) throw new JarvisError("CORE5_MAIL_HUMAN_OWNED", path);
    }
  }

  private persist(operationId: string, draft: MailDraftObservation): MailDraftCard {
    this.assertHumanOwnedPath(`/api/mail/send-drafts/${draft.draft_id}`);
    const card_state = cardStateFromMailDraft(draft);
    const ref: MailDraftRef = {
      operation_id: operationId,
      draft_id: draft.draft_id,
      owner_principal: "agent:jarvis",
      review_href: mailReviewHref(this.mailOrigin, draft.draft_id),
      payload_digest: draft.payload_digest ?? null,
      mail_status: draft.status,
      card_state,
      observed_at: this.now().toISOString(),
    };
    const stored = this.store.upsert(ref);
    return {
      operation_id: stored.operation_id,
      draft_id: stored.draft_id,
      review_href: stored.review_href,
      mail_status: stored.mail_status,
      card_state: stored.card_state,
      owner_principal: "agent:jarvis",
    };
  }
}
