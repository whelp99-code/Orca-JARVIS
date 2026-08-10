import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import type { OrcaResumeAdapter, ResumeAck } from "./pre-gjc-shadow.js";

type Provider = "codex" | "claude";
type Row = Record<string, unknown>;
export type OrcaCommand = (args: readonly string[]) => string;
export interface LiveResumeIntent {
  intent_id: string; project_id: string; provider: Provider; terminal_id: string;
  session_id: string; incarnation_id: string; signal_event_id: string; attempt_id: string;
  lease_id: string; fence: number; pty_id?: string; worktree_id?: string; prompt_digest?: string;
  authorization_kind?: "human" | "policy";
}

const sha = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const defaultCommand: OrcaCommand = args => {
  try { return execFileSync("orca", [...args], { encoding: "utf8", maxBuffer: 1_000_000, windowsHide: true }); }
  catch { throw new JarvisError("ORCA_RESUME_COMMAND_FAILED"); }
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("ORCA_RESUME_SCHEMA_INVALID");
  return value as Record<string, unknown>;
};
const response = (text: string): Record<string, unknown> => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new JarvisError("ORCA_RESUME_SCHEMA_INVALID"); }
  const root = record(value); if (root.ok !== true) throw new JarvisError("ORCA_RESUME_COMMAND_FAILED");
  return record(root.result);
};
const field = (value: Record<string, unknown>, key: string): string => {
  const candidate = value[key]; if (typeof candidate !== "string" || candidate.length === 0) throw new JarvisError("ORCA_RESUME_SCHEMA_INVALID");
  return candidate;
};

/**
 * The sole live mutation boundary. It calls public `orca terminal show` and
 * `orca terminal send` with argv, never a shell string. A persisted `sending`
 * marker makes post-send uncertainty terminal: no blind replay is possible.
 */
export class OrcaTerminalResumeAdapter implements OrcaResumeAdapter {
  constructor(private readonly authority: AuthorityDb, private readonly enabled = false, private readonly command: OrcaCommand = defaultCommand, private readonly clock: () => Date = () => new Date()) {}
  private prompt(): string { return "Resume only the already-authorized bounded work. Do not widen scope or perform external actions."; }
  private tables(intent: LiveResumeIntent): { attempts: string; intents: string } {
    return intent.authorization_kind === "policy"
      ? { attempts: "pre_gjc_policy_resume_attempts", intents: "pre_gjc_policy_resume_intents" }
      : { attempts: "pre_gjc_live_resume_attempts", intents: "pre_gjc_resume_intents" };
  }
  private transition(intent: LiveResumeIntent, state: "prepared" | "sending" | "delivered" | "uncertain", promptDigest: string, receipt?: string): void {
    const db = this.authority.db;
    const tables = this.tables(intent);
    const previous = db.prepare(`SELECT state,prompt_digest FROM ${tables.attempts} WHERE intent_id=?`).get(intent.intent_id) as Row | undefined;
    if (previous && (previous.prompt_digest !== promptDigest || (previous.state === "delivered" && state !== "delivered"))) throw new JarvisError("PRE_GJC_RESUME_UNCERTAIN");
    if (!previous) db.prepare(`INSERT INTO ${tables.attempts}(intent_id,provider,terminal_handle,session_id,incarnation_id,prompt_digest,state,created_at,updated_at,pty_id,worktree_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(intent.intent_id, intent.provider, intent.terminal_id, intent.session_id, intent.incarnation_id, promptDigest, state, this.clock().toISOString(), this.clock().toISOString(), intent.pty_id ?? null, intent.worktree_id ?? null);
    else db.prepare(`UPDATE ${tables.attempts} SET state=?,receipt_digest=COALESCE(?,receipt_digest),updated_at=? WHERE intent_id=? AND prompt_digest=?`).run(state, receipt ?? null, this.clock().toISOString(), intent.intent_id, promptDigest);
  }
  resume(intent: LiveResumeIntent): ResumeAck {
    if (!this.enabled || (intent.provider !== "codex" && intent.provider !== "claude")) throw new JarvisError("ORCA_RESUME_DISABLED");
    if (!intent.pty_id || !intent.worktree_id || !intent.prompt_digest) throw new JarvisError("ORCA_RESUME_BINDING_MISMATCH");
    const prompt = this.prompt(); const promptDigest = sha({ provider: intent.provider, terminal_id: intent.terminal_id, session_id: intent.session_id, incarnation_id: intent.incarnation_id, pty_id: intent.pty_id, worktree_id: intent.worktree_id, prompt });
    if (intent.prompt_digest !== promptDigest) throw new JarvisError("ORCA_RESUME_BINDING_MISMATCH");
    const tables = this.tables(intent);
    const previous = this.authority.db.prepare(`SELECT state FROM ${tables.attempts} WHERE intent_id=?`).get(intent.intent_id) as Row | undefined;
    if (previous?.state === "delivered") { const delivered = this.authority.db.prepare(`SELECT delivery_receipt_json,delivered_at FROM ${tables.intents} WHERE intent_id=?`).get(intent.intent_id) as Row | undefined; if (!delivered || typeof delivered.delivery_receipt_json !== "string" || typeof delivered.delivered_at !== "string") throw new JarvisError("PRE_GJC_RESUME_UNCERTAIN"); const parsed = record(JSON.parse(delivered.delivery_receipt_json)); return { intent_id: intent.intent_id, receipt: field(parsed, "receipt"), delivered_at: String(delivered.delivered_at) }; }
    if (previous?.state === "sending" || previous?.state === "uncertain") { this.transition(intent, "uncertain", promptDigest); this.authority.db.prepare(`UPDATE ${tables.intents} SET state='blocked' WHERE intent_id=? AND state IN ('claimed','pending')`).run(intent.intent_id); throw new JarvisError("PRE_GJC_RESUME_UNCERTAIN"); }
    this.transition(intent, "prepared", promptDigest);
    const shown = response(this.command(["terminal", "show", "--terminal", intent.terminal_id, "--json"]));
    const terminal = record(shown.terminal);
    if (field(terminal, "handle") !== intent.terminal_id || field(terminal, "incarnationId") !== intent.incarnation_id || field(terminal, "ptyId") !== intent.pty_id || field(terminal, "worktreeId") !== intent.worktree_id || terminal.connected !== true || terminal.writable !== true) throw new JarvisError("ORCA_RESUME_BINDING_MISMATCH");
    this.transition(intent, "sending", promptDigest);
    let sent: Record<string, unknown>;
    try { sent = response(this.command(["terminal", "send", "--terminal", intent.terminal_id, "--text", prompt, "--enter", "--json"])); }
    catch (error) { this.transition(intent, "uncertain", promptDigest); this.authority.db.prepare(`UPDATE ${tables.intents} SET state='blocked' WHERE intent_id=? AND state='claimed'`).run(intent.intent_id); throw error; }
    const receipt = sha({ intent_id: intent.intent_id, prompt_digest: promptDigest, response: sent }); const delivered_at = this.clock().toISOString();
    this.transition(intent, "delivered", promptDigest, receipt);
    return { intent_id: intent.intent_id, receipt, delivered_at };
  }
}
