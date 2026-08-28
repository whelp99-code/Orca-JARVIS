import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { PersistenceErrorFactory } from "./personal-persistence-values.js";
import type { OrcaObservationDelta, OrcaObservationSource } from "./types.js";

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function row(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRow(value) ? value : undefined;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export class OrcaObservationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  getSource(worktree: string, terminalHandle: string): OrcaObservationSource | undefined {
    const stored = row(this.database.prepare(
      `SELECT worktree_selector,terminal_handle,provider,incarnation_id,next_cursor
       FROM orca_observation_sources
       WHERE worktree_selector=? AND terminal_handle=?`,
    ).get(worktree, terminalHandle));
    if (stored === undefined) return undefined;
    const provider = stored["provider"];
    if (provider !== "codex" && provider !== "claude") throw this.error("ORCA_OBSERVATION_INVALID");
    return {
      worktree: String(stored["worktree_selector"]),
      terminal_handle: String(stored["terminal_handle"]),
      provider,
      incarnation_id: String(stored["incarnation_id"]),
      next_cursor: stored["next_cursor"] === null ? null : String(stored["next_cursor"]),
    };
  }

  record(source: OrcaObservationSource, deltas: readonly OrcaObservationDelta[]): {
    readonly inserted: number;
    readonly replayed: number;
  } {
    if (!source.worktree || !source.terminal_handle || !source.incarnation_id
      || (source.provider !== "codex" && source.provider !== "claude")) {
      throw this.error("ORCA_OBSERVATION_INVALID");
    }
    return this.database.transaction(() => {
      let inserted = 0;
      let replayed = 0;
      for (const delta of deltas) {
        this.validateDelta(source, delta);
        const deltaDigest = digest({
          worktree: delta.worktree,
          terminal_handle: delta.terminal_handle,
          provider: delta.provider,
          incarnation_id: delta.incarnation_id,
          cursor_before: delta.cursor_before,
          cursor_after: delta.cursor_after,
          tail: delta.tail,
          truncated: delta.truncated,
          limited: delta.limited,
          oldest_cursor: delta.oldest_cursor,
          latest_cursor: delta.latest_cursor,
          returned_line_count: delta.returned_line_count,
        });
        const prior = row(this.database.prepare(
          "SELECT digest FROM orca_observation_deltas WHERE identity=?",
        ).get(delta.identity));
        if (prior !== undefined) {
          if (prior["digest"] !== deltaDigest) throw this.error("ORCA_OBSERVATION_REPLAY_CONFLICT");
          replayed++;
          continue;
        }
        this.database.prepare(
          `INSERT INTO orca_observation_deltas(
             identity,worktree_selector,terminal_handle,provider,incarnation_id,cursor_before,cursor_after,
             tail_json,digest,truncated,limited,oldest_cursor,latest_cursor,returned_line_count,observed_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          delta.identity,
          delta.worktree,
          delta.terminal_handle,
          delta.provider,
          delta.incarnation_id,
          delta.cursor_before,
          delta.cursor_after,
          canonicalize(delta.tail),
          deltaDigest,
          delta.truncated ? 1 : 0,
          delta.limited ? 1 : 0,
          delta.oldest_cursor,
          delta.latest_cursor,
          delta.returned_line_count,
          delta.observed_at,
        );
        inserted++;
      }
      this.database.prepare(
        `INSERT INTO orca_observation_sources(
           worktree_selector,terminal_handle,provider,incarnation_id,next_cursor,updated_at
         ) VALUES(?,?,?,?,?,?)
         ON CONFLICT(worktree_selector,terminal_handle) DO UPDATE SET
           provider=excluded.provider,incarnation_id=excluded.incarnation_id,
           next_cursor=excluded.next_cursor,updated_at=excluded.updated_at`,
      ).run(
        source.worktree,
        source.terminal_handle,
        source.provider,
        source.incarnation_id,
        source.next_cursor,
        new Date().toISOString(),
      );
      return { inserted, replayed };
    }).immediate();
  }

  private validateDelta(source: OrcaObservationSource, delta: OrcaObservationDelta): void {
    if (delta.worktree !== source.worktree
      || delta.terminal_handle !== source.terminal_handle
      || delta.provider !== source.provider
      || delta.incarnation_id !== source.incarnation_id
      || !delta.identity
      || !Array.isArray(delta.tail)
      || !delta.tail.every(line => typeof line === "string")
      || !Number.isInteger(delta.returned_line_count)
      || delta.returned_line_count < 0) {
      throw this.error("ORCA_OBSERVATION_INVALID");
    }
  }
}
