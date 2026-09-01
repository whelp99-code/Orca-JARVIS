export type BackupFlags = Readonly<{ eligible: 0 | 1; state: 0 | 1 }>;
export type BackupOutcome =
  | { readonly kind: "accept"; readonly next: BackupFlags }
  | { readonly kind: "reject"; readonly reason: "BACKUP_FLAGS_INVALID" | "BACKUP_ELIGIBILITY_MISMATCH" };

export function evaluateBackup(stored: BackupFlags, returned: BackupFlags): BackupOutcome {
  if (stored.eligible === 0 && stored.state === 0) {
    if (returned.eligible === 0 && returned.state === 0) return { kind: "accept", next: stored };
    if (returned.eligible === 0 && returned.state === 1) return { kind: "reject", reason: "BACKUP_FLAGS_INVALID" };
    return { kind: "reject", reason: "BACKUP_ELIGIBILITY_MISMATCH" };
  }
  if (stored.eligible === 1 && stored.state === 0) {
    if (returned.eligible === 1 && returned.state === 0) return { kind: "accept", next: stored };
    if (returned.eligible === 1 && returned.state === 1) return { kind: "accept", next: { eligible: 1, state: 1 } };
    return { kind: "reject", reason: "BACKUP_ELIGIBILITY_MISMATCH" };
  }
  if (stored.eligible === 1 && stored.state === 1) {
    if (returned.eligible === 1 && returned.state === 1) return { kind: "accept", next: stored };
    if (returned.eligible === 1 && returned.state === 0) return { kind: "accept", next: { eligible: 1, state: 0 } };
    return { kind: "reject", reason: "BACKUP_ELIGIBILITY_MISMATCH" };
  }
  return { kind: "reject", reason: "BACKUP_FLAGS_INVALID" };
}

export type CounterDisposition = "zero" | "advanced" | "nonincreasing" | "not_checked";

export function evaluateCounter(stored: number, returned: number): {
  readonly kind: "accept" | "reject";
  readonly next: number;
  readonly mode: "zero" | "monotonic";
  readonly disposition: CounterDisposition;
} {
  if (!Number.isInteger(stored) || !Number.isInteger(returned) || stored < 0 || returned < 0 || returned > 0xffffffff) {
    return { kind: "reject", next: stored, mode: stored === 0 ? "zero" : "monotonic", disposition: "not_checked" };
  }
  if (stored === 0 && returned === 0) {
    return { kind: "accept", next: 0, mode: "zero", disposition: "zero" };
  }
  if (stored === 0 && returned > 0) {
    return { kind: "accept", next: returned, mode: "monotonic", disposition: "advanced" };
  }
  if (stored > 0 && returned > stored) {
    return { kind: "accept", next: returned, mode: "monotonic", disposition: "advanced" };
  }
  return { kind: "reject", next: stored, mode: "monotonic", disposition: "nonincreasing" };
}
