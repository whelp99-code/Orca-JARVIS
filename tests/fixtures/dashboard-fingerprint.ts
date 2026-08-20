import Database from "better-sqlite3";

const FINGERPRINT_SQL = `SELECT
  (SELECT COUNT(*) FROM control_command_requests) AS requests,
  (SELECT COUNT(*) FROM control_command_receipts) AS receipts,
  (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions,
  (SELECT COUNT(*) FROM control_command_effects) AS effects,
  (SELECT COUNT(*) FROM control_command_revocations) AS revocations,
  (SELECT COUNT(*) FROM workflow_runs) AS runs,
  (SELECT COUNT(*) FROM workflow_steps) AS steps,
  (SELECT COUNT(*) FROM workflow_transitions) AS transitions
`;

export type ProtectedFingerprint = {
  readonly requests: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly counts: unknown;
  readonly runs: readonly unknown[];
};

export function protectedFingerprint(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const payload: ProtectedFingerprint = {
      requests: db.prepare(
        "SELECT request_id,state,lease_fence,completed_at,failure_code FROM control_command_requests ORDER BY request_id",
      ).all(),
      receipts: db.prepare(
        "SELECT receipt_id,request_id,decision FROM control_command_receipts ORDER BY receipt_id",
      ).all(),
      counts: db.prepare(FINGERPRINT_SQL).get(),
      runs: db.prepare(
        "SELECT run_id,state,current_node,completed_at FROM workflow_runs ORDER BY run_id",
      ).all(),
    };
    return JSON.stringify(payload);
  } finally {
    db.close();
  }
}

export function loadControlCommand(dbPath: string, requestId: string): {
  readonly request_id: string;
  readonly command_digest: string;
  readonly expires_at: string;
  readonly state: string;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      "SELECT request_id,command_digest,expires_at,state FROM control_command_requests WHERE request_id=?",
    ).get(requestId);
    if (row === undefined || typeof row !== "object" || row === null) {
      throw new Error(`control request missing: ${requestId}`);
    }
    const record = row as Record<string, unknown>;
    if (typeof record.request_id !== "string" || typeof record.command_digest !== "string"
      || typeof record.expires_at !== "string" || typeof record.state !== "string") {
      throw new Error(`control request invalid: ${requestId}`);
    }
    return {
      request_id: record.request_id,
      command_digest: record.command_digest,
      expires_at: record.expires_at,
      state: record.state,
    };
  } finally {
    db.close();
  }
}
