-- Core5 J04: JARVIS stores/references Mail drafts. Humans approve/send in Mail UI.
CREATE TABLE core5_mail_draft_refs (
  operation_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL CHECK (owner_principal = 'agent:jarvis'),
  review_href TEXT NOT NULL,
  payload_digest TEXT,
  mail_status TEXT NOT NULL,
  card_state TEXT CHECK (card_state IN (
    'approval_required',
    'sending',
    'result_unconfirmed',
    'follow_up_needed'
  )),
  observed_at TEXT NOT NULL
);
