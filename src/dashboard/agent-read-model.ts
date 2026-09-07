import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import type { AuthorityDb } from "../db.js";
import type { OverviewAgent } from "./legacy-read-contracts.js";

export const AGENT_OBSERVATION_TTL_MS = 120_000;
type BindingRow = {
  canonical_path: string; provider: string; terminal_id: string; session_id: string; incarnation_id: string;
  observed_session: string | null; observed_incarnation: string | null;
  updated_at: string | null; connected: number | null;
};

/** Availability is a recent structured connection observation, not progress or authority to execute. */
export function listedAgents(db: AuthorityDb, now: Date): readonly OverviewAgent[] {
  const rows = db.db.prepare(`SELECT b.canonical_path,b.provider,b.terminal_id,b.session_id,b.incarnation_id,
    c.session_id AS observed_session,c.incarnation_id AS observed_incarnation,c.updated_at,c.connected
    FROM live_supervisor_bindings b LEFT JOIN live_supervisor_cursors c
    USING(canonical_path,provider,terminal_id)`).all() as BindingRow[];
  return rows.sort((left, right) => left.canonical_path.localeCompare(right.canonical_path)
    || left.provider.localeCompare(right.provider) || left.terminal_id.localeCompare(right.terminal_id)
    || left.incarnation_id.localeCompare(right.incarnation_id)).map(row => {
    const identity = { canonical_path: row.canonical_path, provider: row.provider,
      terminal_id: row.terminal_id, incarnation_id: row.incarnation_id };
    const observed = row.updated_at === null ? Number.NaN : Date.parse(row.updated_at);
    const age = now.getTime() - observed;
    const matches = row.session_id === row.observed_session && row.incarnation_id === row.observed_incarnation;
    const valid = matches && Number.isFinite(age) && age >= 0 && (row.connected === 0 || row.connected === 1);
    const status = !valid ? "unknown" : age >= AGENT_OBSERVATION_TTL_MS ? "stale"
      : row.connected === 0 ? "offline" : "live";
    return { ...identity, agent_id: `sha256:${createHash("sha256").update(canonicalize(identity)).digest("hex")}`,
      status, observed_at: valid ? new Date(observed).toISOString() : null };
  });
}
