import { lstatSync, readFileSync } from "node:fs";

export type RehearsalAcceptance = {
  readonly path: string;
  readonly source_vector_digest: string;
  readonly target_vector_digest: string;
  readonly quick_check: string | null;
  readonly foreign_key_violations: number | null;
  readonly applied_migrations: number;
};

export type RehearsalReceiptRead =
  | { readonly kind: "read"; readonly receipt: RehearsalAcceptance }
  | { readonly kind: "invalid"; readonly code: string };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads a `db migrate --rehearse --rehearsal-receipt` receipt. It never throws: an unreadable,
 * malformed or failed rehearsal is reported as an invalid receipt and the gate fails closed on it.
 */
export function readRehearsalReceipt(path: string): RehearsalReceiptRead {
  const invalid = { kind: "invalid", code: "RELEASE_GATE_REHEARSAL_RECEIPT_INVALID" } as const;
  let parsed: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return invalid;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid;
  const body = parsed as Record<string, unknown>;
  const checks = typeof body["checks"] === "object" && body["checks"] !== null
    ? body["checks"] as Record<string, unknown>
    : undefined;
  const source = text(body["source_vector_digest"]);
  const target = text(body["target_vector_digest"]);
  const applied = body["applied_migrations"];
  if (body["schema_version"] !== 1 || body["kind"] !== "migration-rehearsal" || body["ok"] !== true) return invalid;
  if (source === undefined || target === undefined || checks === undefined || !Array.isArray(applied)) return invalid;
  return {
    kind: "read",
    receipt: {
      path,
      source_vector_digest: source,
      target_vector_digest: target,
      quick_check: typeof checks["quick_check"] === "string" ? checks["quick_check"] as string : null,
      foreign_key_violations: typeof checks["foreign_key_violations"] === "number"
        ? checks["foreign_key_violations"] as number
        : null,
      applied_migrations: applied.length,
    },
  };
}

/**
 * Whether a rehearsal receipt licenses a still-pending vector for this database and this release:
 * the rehearsal started from exactly the vector the database is on now, its migrated copy passed
 * quick_check with no foreign-key violations, and it landed on exactly the vector this release
 * ships. Anything else is not this database's rehearsal and is refused.
 */
export function rehearsalAccepts(
  receipt: RehearsalAcceptance,
  appliedDigest: string,
  expectedDigest: string,
): { readonly ok: boolean; readonly code?: string } {
  if (receipt.quick_check !== "ok" || receipt.foreign_key_violations !== 0) {
    return { ok: false, code: "RELEASE_GATE_REHEARSAL_CHECKS_FAILED" };
  }
  if (receipt.source_vector_digest !== appliedDigest || receipt.target_vector_digest !== expectedDigest) {
    return { ok: false, code: "RELEASE_GATE_REHEARSAL_VECTOR_MISMATCH" };
  }
  return { ok: true };
}
