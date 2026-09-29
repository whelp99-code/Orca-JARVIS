import type Database from "better-sqlite3";
import { JarvisError } from "../jarvis-error.js";
import type { MailDraftCardState } from "./mail-draft-card.js";

export type MailDraftRef = {
  readonly operation_id: string;
  readonly draft_id: string;
  readonly owner_principal: "agent:jarvis";
  readonly review_href: string;
  readonly payload_digest: string | null;
  readonly mail_status: string;
  readonly card_state: MailDraftCardState | null;
  readonly observed_at: string;
};

export class Core5MailDraftStore {
  constructor(private readonly database: Database.Database) {}

  get(operationId: string): MailDraftRef | undefined {
    return this.database.prepare(
      `SELECT operation_id, draft_id, owner_principal, review_href, payload_digest, mail_status, card_state, observed_at
       FROM core5_mail_draft_refs WHERE operation_id=?`,
    ).get(operationId) as MailDraftRef | undefined;
  }

  byDraft(draftId: string): MailDraftRef | undefined {
    return this.database.prepare(
      `SELECT operation_id, draft_id, owner_principal, review_href, payload_digest, mail_status, card_state, observed_at
       FROM core5_mail_draft_refs WHERE draft_id=?`,
    ).get(draftId) as MailDraftRef | undefined;
  }

  upsert(ref: MailDraftRef): MailDraftRef {
    if (ref.owner_principal !== "agent:jarvis") {
      throw new JarvisError("CORE5_MAIL_PRINCIPAL_INVALID", ref.owner_principal);
    }
    this.database.prepare(
      `INSERT INTO core5_mail_draft_refs(operation_id,draft_id,owner_principal,review_href,payload_digest,mail_status,card_state,observed_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(operation_id) DO UPDATE SET
         draft_id=excluded.draft_id,
         review_href=excluded.review_href,
         payload_digest=excluded.payload_digest,
         mail_status=excluded.mail_status,
         card_state=excluded.card_state,
         observed_at=excluded.observed_at`,
    ).run(
      ref.operation_id,
      ref.draft_id,
      ref.owner_principal,
      ref.review_href,
      ref.payload_digest,
      ref.mail_status,
      ref.card_state,
      ref.observed_at,
    );
    const stored = this.get(ref.operation_id);
    if (stored === undefined) throw new JarvisError("CORE5_MAIL_REF_MISSING", ref.operation_id);
    return stored;
  }
}
