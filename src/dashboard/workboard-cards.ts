import type Database from "better-sqlite3";
import type { WorkboardActions } from "../workboard/actions.js";
import type { AttentionItem, AttentionRow } from "../workboard/attention.js";
import type { WorkboardProjection } from "../workboard/projection.js";
import type {
  WorkboardCard,
  WorkboardEvidenceItem,
  WorkboardGroup,
  WorkboardPurposeStatus,
} from "./workboard-routes.js";

type WorkRow = AttentionRow & {
  session_id: string; task_id: string | null; parent_work_id: string | null; source_key: string;
  sequence: number; summary: string; evidence_ref: string; attempt_key: string;
};
type PurposeRow = { project_id: string; version: number; text: string; source_ref: string };
type CandidateRow = { project_id: string; text: string; source_kind: "explicit_request" | "agent_summary"; source_ref: string };
type BindingRow = {
  work_id: string; project_id: string; why: string; evidence_kind: string; evidence_ref: string;
  purpose_version: number | null; work_spec_revision: string;
};
type ResolvedPurpose = { text: string; confirmed: PurposeRow | null; evidence: string };
type PurposeIndex = {
  readonly bindings: ReadonlyMap<string, BindingRow>;
  readonly resolve: (project: string) => ResolvedPurpose | null;
};

/** Read-only replica of PurposeStore.view selection rules; the store constructor would run migrations. */
function loadPurposes(db: Database.Database): PurposeIndex {
  const bindings = new Map<string, BindingRow>();
  for (const row of db.prepare("SELECT * FROM workboard_purpose_bindings").all() as BindingRow[]) bindings.set(row.work_id, row);
  const latest = new Map<string, PurposeRow>();
  for (const row of db.prepare(
    "SELECT project_id,version,text,source_ref FROM workboard_purposes ORDER BY project_id,version",
  ).all() as PurposeRow[]) {
    latest.set(row.project_id, row);
  }
  const candidates = new Map<string, CandidateRow[]>();
  for (const row of db.prepare(
    "SELECT project_id,text,source_kind,source_ref FROM workboard_purpose_candidates"
    + " ORDER BY project_id,source_kind,source_ref",
  ).all() as CandidateRow[]) {
    const list = candidates.get(row.project_id) ?? [];
    list.push(row);
    candidates.set(row.project_id, list);
  }
  return {
    bindings,
    resolve(project) {
      const confirmed = latest.get(project);
      if (confirmed !== undefined) return { text: confirmed.text, confirmed, evidence: `owner:${confirmed.source_ref}` };
      const list = candidates.get(project) ?? [];
      const priority = list.some(c => c.source_kind === "explicit_request") ? "explicit_request" : "agent_summary";
      const eligible = list.filter(c => c.source_kind === priority);
      const first = eligible[0];
      if (first === undefined || new Set(eligible.map(c => c.text)).size !== 1) return null;
      return { text: first.text, confirmed: null, evidence: `${first.source_kind}:${first.source_ref}` };
    },
  };
}

function toCard(row: WorkRow, attention: AttentionItem, purposes: PurposeIndex): WorkboardCard {
  const binding = purposes.bindings.get(row.work_id);
  const resolved = binding === undefined ? null : purposes.resolve(binding.project_id);
  const status: WorkboardPurposeStatus = binding === undefined || resolved === null ? "unknown"
    : resolved.confirmed !== null && binding.evidence_kind !== "agent_summary" ? "confirmed" : "proposed";
  const needs_reconfirmation = binding !== undefined && resolved?.confirmed != null
    && binding.purpose_version !== null && binding.purpose_version !== resolved.confirmed.version && row.state === "running";
  const source = splitSourceKey(row.source_key);
  const evidence: WorkboardEvidenceItem[] = [
    { label: "작업 키", value: row.work_id },
    { label: "관측 원천", value: row.source_key },
    { label: "원천 세대", value: source.generation },
    { label: "세션", value: row.session_id },
    { label: "시도", value: row.attempt_key },
    { label: "관측 근거", value: row.evidence_ref },
  ];
  if (row.task_id !== null) evidence.push({ label: "원천 작업 ID", value: row.task_id });
  if (row.parent_work_id !== null) evidence.push({ label: "상위 작업 키", value: row.parent_work_id });
  if (binding !== undefined) {
    evidence.push({ label: "목적 연결 근거", value: `${binding.evidence_kind}:${binding.evidence_ref}` });
    evidence.push({ label: "작업 명세 리비전", value: binding.work_spec_revision });
  }
  if (resolved !== null) evidence.push({ label: "목적 출처", value: resolved.evidence });
  return {
    work_id: row.work_id,
    summary: row.summary,
    source: { host: source.host, app: source.app, scope: source.scope },
    disposition: attention.disposition,
    attempt_execution: attention.attemptExecution,
    action_delivery: attention.actionDelivery,
    freshness: attention.freshness,
    rank: attention.rank,
    reasons: attention.reasons,
    wait_kind: row.wait_kind ?? null,
    wait_reason: attention.waitReason,
    wait_started_at: attention.waitStartedAt,
    deadline_at: attention.deadlineAt,
    impact: attention.impact,
    actions_enabled: attention.actionsEnabled,
    warning: row.warning,
    source_at: row.source_at,
    observed_at: row.last_successful_observation,
    purpose: {
      project_id: binding?.project_id ?? null,
      text: resolved?.text ?? null,
      status,
      why: binding?.why ?? null,
      needs_reconfirmation,
    },
    evidence,
  };
}

/** sourceKey is `${host}:${app}:${scope}:${generation}`; generation is evidence, not a headline. */
function splitSourceKey(key: string): { host: string; app: string; scope: string; generation: string } {
  const parts = key.split(":");
  if (parts.length < 4) return { host: key, app: "", scope: "", generation: "" };
  return { host: parts[0] ?? "", app: parts[1] ?? "", scope: parts.slice(2, -1).join(":"), generation: parts[parts.length - 1] ?? "" };
}

const rankOrder = (rank: AttentionItem["rank"]): number => rank ?? 4;

function groupByPurpose(cards: readonly WorkboardCard[]): WorkboardGroup[] {
  const groups = new Map<string | null, {
    project_id: string | null; purpose: string | null; status: WorkboardPurposeStatus; works: WorkboardCard[];
  }>();
  for (const card of cards) {
    const key = card.purpose.project_id;
    const group = groups.get(key) ?? { project_id: key, purpose: card.purpose.text, status: card.purpose.status, works: [] };
    group.works.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    works: [...group.works].sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.work_id.localeCompare(b.work_id)),
  })).sort((a, b) => {
    const urgency = rankOrder(a.works[0]?.rank ?? null) - rankOrder(b.works[0]?.rank ?? null);
    if (urgency !== 0) return urgency;
    if (a.project_id === null) return b.project_id === null ? 0 : 1;
    if (b.project_id === null) return -1;
    return a.project_id.localeCompare(b.project_id);
  });
}

export function assembleWorkboard(
  db: Database.Database,
  projection: WorkboardProjection,
  actions?: WorkboardActions,
): { readonly attention: readonly WorkboardCard[]; readonly groups: readonly WorkboardGroup[] } {
  const purposes = loadPurposes(db);
  const cards = new Map<string, WorkboardCard>();
  for (const row of projection.works as Array<WorkRow & { attention: AttentionItem }>) {
    const card = toCard(row, row.attention, purposes);
    cards.set(row.work_id, actions ? { ...card, action_capability: actions.capability(row.work_id) } : card);
  }
  return {
    attention: projection.attention.flatMap(item => {
      const card = cards.get(item.workId);
      return card === undefined ? [] : [card];
    }),
    groups: groupByPurpose([...cards.values()]),
  };
}
