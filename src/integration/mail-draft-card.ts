import { JarvisError } from "../jarvis-error.js";

export const MAIL_DRAFT_CARD_STATES = Object.freeze([
  "approval_required",
  "sending",
  "result_unconfirmed",
  "follow_up_needed",
] as const);

export type MailDraftCardState = (typeof MAIL_DRAFT_CARD_STATES)[number];

export type MailDraftObservation = {
  readonly draft_id: string;
  readonly status: string;
  readonly owner_principal?: string;
  readonly payload_digest?: string;
  readonly failure_reason?: string | null;
  readonly uncertain?: boolean;
};

/** JARVIS card mirror. Mail UI remains the review/approve/send surface. */
export function cardStateFromMailDraft(draft: MailDraftObservation): MailDraftCardState | null {
  if (draft.status === "needs_approval" || draft.status === "approved") return "approval_required";
  if (draft.status === "sending") {
    if (draft.uncertain === true || (draft.failure_reason !== undefined && draft.failure_reason !== null && draft.failure_reason !== "")) {
      return "result_unconfirmed";
    }
    return "sending";
  }
  if (draft.status === "needs_clarification" || draft.status === "failed") return "follow_up_needed";
  if (draft.status === "sent" || draft.status === "cancelled") return null;
  throw new JarvisError("CORE5_MAIL_STATUS_UNKNOWN", draft.status);
}

export function mailReviewHref(mailOrigin: string, draftId: string): string {
  const origin = new URL(mailOrigin);
  return `${origin.origin}/#sendDraftReview?draft=${encodeURIComponent(draftId)}`;
}
