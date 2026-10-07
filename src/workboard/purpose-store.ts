import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionPurposeRef, Purpose, PurposeEvidence, WorkPurposeBinding } from "./purpose.js";

type PurposeRow = { project_id: string; version: number; text: string; source_kind: "owner"; source_ref: string };
type CandidateRow = { text: string; source_kind: "explicit_request" | "agent_summary"; source_ref: string };
type BindingRow = { work_id: string; project_id: string; why: string; evidence_kind: PurposeEvidence["kind"];
  evidence_ref: string; purpose_version: number | null; work_spec_revision: string };

function nonempty(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("WORKBOARD_PURPOSE_INVALID");
}
function evidence(value: PurposeEvidence, allowed: readonly string[]): void {
  if (!value || !allowed.includes(value.kind)) throw new Error("WORKBOARD_PURPOSE_SOURCE_INVALID");
  nonempty(value.ref);
}
function asPurpose(row: PurposeRow): Purpose {
  return { project_id: row.project_id, version: row.version, text: row.text,
    source: { kind: "owner", ref: row.source_ref } };
}

/** The caller must authenticate owner confirmation before calling confirm; source labels alone confer no authority. */
export class PurposeStore {
  constructor(readonly db: Database.Database) {
    db.exec(readFileSync(resolve("migrations/100_workboard_purpose.sql"), "utf8"));
  }
  propose(project: string, text: string, source: PurposeEvidence): void {
    nonempty(project); nonempty(text); evidence(source, ["explicit_request", "agent_summary"]);
    const old = this.db.prepare("SELECT text FROM workboard_purpose_candidates WHERE project_id=? AND source_kind=? AND source_ref=?")
      .get(project, source.kind, source.ref) as { text: string } | undefined;
    if (old && old.text !== text) throw new Error("WORKBOARD_PURPOSE_EVIDENCE_CONFLICT");
    this.db.prepare("INSERT OR IGNORE INTO workboard_purpose_candidates(project_id,text,source_kind,source_ref) VALUES(?,?,?,?)")
      .run(project, text, source.kind, source.ref);
  }
  confirm(project: string, text: string, ref: string): Purpose {
    nonempty(project); nonempty(text); nonempty(ref);
    return this.db.transaction(() => {
      const old = this.latest(project);
      const purpose = old?.text === text ? asPurpose(old) : this.insertPurpose(project, (old?.version ?? 0) + 1, text, ref);
      // A bind made before any owner purpose stored a null version. Pin it to this confirmation
      // so later revisions invalidate, and preflight can see purpose_version === latest.
      this.db.prepare(`UPDATE workboard_purpose_bindings SET purpose_version=?
        WHERE project_id=? AND purpose_version IS NULL AND evidence_kind IN ('owner','explicit_request')`)
        .run(purpose.version, project);
      return purpose;
    })();
  }
  bind(work: string, project: string, why: string, proof: PurposeEvidence, work_spec_revision: string): void {
    nonempty(work); nonempty(project); nonempty(why); nonempty(work_spec_revision);
    evidence(proof, ["owner", "explicit_request", "agent_summary"]);
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM workboard_works WHERE work_id=?").get(work)) throw new Error("WORKBOARD_WORK_UNKNOWN");
      const prior = this.binding(work);
      if (prior && prior.project_id !== project) throw new Error("WORKBOARD_PURPOSE_PROJECT_CONFLICT");
      const version = this.latest(project)?.version ?? null;
      this.db.prepare(`INSERT INTO workboard_purpose_bindings(work_id,project_id,why,evidence_kind,evidence_ref,purpose_version,work_spec_revision)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET why=excluded.why,evidence_kind=excluded.evidence_kind,
        evidence_ref=excluded.evidence_ref,purpose_version=excluded.purpose_version,work_spec_revision=excluded.work_spec_revision`)
        .run(work, project, why, proof.kind, proof.ref, version, work_spec_revision);
    })();
  }
  view(work_id: string, project_id: string): WorkPurposeBinding {
    const binding = this.binding(work_id);
    if (binding && binding.project_id !== project_id) throw new Error("WORKBOARD_PURPOSE_PROJECT_CONFLICT");
    const confirmed = this.latest(project_id);
    const candidates = this.db.prepare(`SELECT text,source_kind,source_ref FROM workboard_purpose_candidates
      WHERE project_id=? ORDER BY source_kind,source_ref`).all(project_id) as CandidateRow[];
    const priority = candidates.some(c => c.source_kind === "explicit_request") ? "explicit_request" : "agent_summary";
    const eligible = candidates.filter(c => c.source_kind === priority);
    const selected = new Set(eligible.map(c => c.text)).size === 1 ? eligible[0] : undefined;
    const purpose: Purpose | null = confirmed ? asPurpose(confirmed) : selected ? {
      project_id, text: selected.text, source: { kind: selected.source_kind, ref: selected.source_ref }, version: 1
    } : null;
    const needs_reconfirmation = !!(confirmed && binding?.purpose_version && binding.purpose_version !== confirmed.version &&
      this.db.prepare("SELECT 1 FROM workboard_works WHERE work_id=? AND state='running'").get(work_id));
    return { work_id, project_id, purpose, why: binding?.why ?? null,
      evidence: binding ? { kind: binding.evidence_kind, ref: binding.evidence_ref } : null,
      status: !binding || !purpose ? "unknown" : confirmed && binding.evidence_kind !== "agent_summary" ? "confirmed" : "proposed",
      needs_reconfirmation };
  }
  actionRef(work: string): ActionPurposeRef {
    const binding = this.binding(work);
    if (!binding) throw new Error("WORKBOARD_PURPOSE_UNKNOWN");
    const view = this.view(work, binding.project_id);
    if (view.needs_reconfirmation) throw new Error("WORKBOARD_PURPOSE_RECONFIRM_REQUIRED");
    if (view.status !== "confirmed" || !view.purpose || view.purpose.source.kind !== "owner") throw new Error("WORKBOARD_PURPOSE_UNKNOWN");
    return { work_id: work, purpose_version: view.purpose.version, work_spec_revision: binding.work_spec_revision };
  }
  assertCurrent(ref: ActionPurposeRef): void {
    const current = this.actionRef(ref.work_id);
    if (current.purpose_version !== ref.purpose_version || current.work_spec_revision !== ref.work_spec_revision)
      throw new Error("WORKBOARD_PURPOSE_RECONFIRM_REQUIRED");
  }
  private insertPurpose(project: string, version: number, text: string, ref: string): Purpose {
    this.db.prepare("INSERT INTO workboard_purposes(project_id,version,text,source_kind,source_ref) VALUES(?,?,?,?,?)")
      .run(project, version, text, "owner", ref);
    return { project_id: project, version, text, source: { kind: "owner", ref } };
  }
  private latest(project: string): PurposeRow | undefined {
    return this.db.prepare("SELECT * FROM workboard_purposes WHERE project_id=? ORDER BY version DESC LIMIT 1").get(project) as PurposeRow | undefined;
  }
  private binding(work: string): BindingRow | undefined {
    return this.db.prepare("SELECT * FROM workboard_purpose_bindings WHERE work_id=?").get(work) as BindingRow | undefined;
  }
}
