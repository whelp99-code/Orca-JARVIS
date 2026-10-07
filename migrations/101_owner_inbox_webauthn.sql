CREATE TABLE owner_inbox_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE owner_inbox_challenges (
  challenge_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE owner_inbox_enrollment_uses (
  code_digest TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);
