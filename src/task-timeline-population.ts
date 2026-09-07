import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { TaskTimelineSummary } from "./task-timeline-model.js";

export const SETTLED_TASK_STATES = [
  "completed", "shadow_completed", "failed", "cancelled", "rejected", "stopped", "expired", "superseded",
] as const;
export const activeTaskState = (state: string): boolean => !(SETTLED_TASK_STATES as readonly string[]).includes(state);
const settledSql = SETTLED_TASK_STATES.map(state => `'${state}'`).join(",");
const taskField = (column: string, field: string): string => `NULLIF(CAST(json_extract(${column},'$.${field}') AS TEXT),'')`;
const runTask = (prefix: string): string => `COALESCE(${taskField(`${prefix}.input_json`, "task_id")},
  ${taskField(`${prefix}.input_json`, "work_id")},NULLIF(${prefix}.correlation_id,''),${prefix}.run_id)`;
const commandTask = `COALESCE(${["target_json", "args_json"].flatMap(column =>
  ["task_id", "work_id", "correlation_id"].map(field => taskField(`c.${column}`, field))).join(",")},
  ${taskField("c.target_json", "run_id")},${taskField("c.args_json", "run_id")},c.request_id)`;

/** Only identities/state metadata cross the SQL boundary; authority payloads stay in SQLite. */
const POPULATION = `WITH canonical_ids AS (
  SELECT id AS task_id FROM work_items UNION SELECT ${runTask("r")} FROM workflow_runs r
), reference_aliases AS (
  SELECT task_id AS alias_id,task_id FROM canonical_ids
  UNION SELECT id,work_id FROM continuation_acceptances WHERE id NOT IN (SELECT task_id FROM canonical_ids)
  UNION SELECT r.run_id,${runTask("r")} FROM workflow_runs r WHERE r.run_id NOT IN (SELECT task_id FROM canonical_ids)
  UNION SELECT r.correlation_id,${runTask("r")} FROM workflow_runs r
    WHERE r.correlation_id<>'' AND r.correlation_id NOT IN (SELECT task_id FROM canonical_ids)
), resolved_aliases AS (
  SELECT alias_id,MIN(task_id) AS task_id FROM reference_aliases GROUP BY alias_id HAVING COUNT(DISTINCT task_id)=1
), raw AS (
  SELECT w.id AS source_id,w.id AS alias_id,w.action AS title,'work' AS kind,
    COALESCE(p.state,w.state) AS state,COALESCE(p.updated_at,w.created_at) AS updated_at,4 AS authority_rank
    FROM work_items w LEFT JOIN work_projection p ON p.work_id=w.id
  UNION ALL
  SELECT c.request_id,${commandTask},c.action,'command',c.state,
    COALESCE(c.completed_at,c.requested_at,c.created_at),2 FROM control_command_requests c
  UNION ALL
  SELECT r.run_id,${runTask("r")},r.loop_id,'workflow',r.state,r.updated_at,3 FROM workflow_runs r
  UNION ALL
  SELECT i.intent_id,COALESCE(NULLIF(i.continuation_id,''),i.intent_id),'GJC '||i.kind,'agent',i.state,
    COALESCE(i.completed_at,i.accepted_at,i.created_at),1 FROM gjc_intents i
), normalized AS (
  SELECT raw.*,COALESCE(a.task_id,raw.alias_id) AS task_id
    FROM raw LEFT JOIN resolved_aliases a ON a.alias_id=raw.alias_id
), aliases AS (
  SELECT task_id AS alias_id,task_id FROM normalized
  UNION SELECT source_id,task_id FROM normalized
  UNION SELECT alias_id,task_id FROM normalized
  UNION SELECT a.alias_id,n.task_id FROM reference_aliases a JOIN normalized n ON n.task_id=a.task_id
), blocked_ids AS (
  SELECT projection_id FROM memory_projection_suppressions
  UNION SELECT projection_id FROM memory_projection_quarantine
), ranked AS (
  SELECT n.*,ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY authority_rank DESC,
    CASE WHEN state NOT IN (${settledSql}) THEN 1 ELSE 0 END DESC,updated_at DESC,source_id ASC) AS ordinal,
    MAX(updated_at) OVER(PARTITION BY task_id) AS latest_at,
    MAX(CASE WHEN (kind='command' AND state='pending') OR (kind='workflow' AND state='waiting_approval')
      OR (kind='work' AND state IN ('pending','awaiting_decision','waiting_approval','approval_required','needs_input'))
      THEN 1 ELSE 0 END) OVER(PARTITION BY task_id) AS pending_approval
  FROM normalized n
), visible AS (
  SELECT * FROM ranked t WHERE ordinal=1 AND NOT EXISTS (
    SELECT 1 FROM aliases a WHERE a.task_id=t.task_id AND a.alias_id IN blocked_ids
  )
)`;

type SummaryRow = { task_id: string; title: string; kind: TaskTimelineSummary["kind"]; state: string;
  latest_at: string; pending_approval: number; source_ids: string };
const summarySelect = `SELECT task_id,title,kind,state,latest_at,pending_approval,
  (SELECT json_group_array(source_id) FROM
    (SELECT DISTINCT source_id FROM normalized n WHERE n.task_id=v.task_id ORDER BY source_id)) AS source_ids
  FROM visible v`;
function decode(row: SummaryRow): TaskTimelineSummary {
  return { task_id: row.task_id, title: row.title, kind: row.kind, state: row.state,
    updated_at: row.latest_at, pending_approval: Boolean(row.pending_approval), source_ids: JSON.parse(row.source_ids) as string[] };
}

export class TaskTimelinePopulation {
  constructor(private readonly authority: AuthorityDb) {}

  list(limit: number, excludeRecommendations = false): TaskTimelineSummary[] {
    new MemoryProjectionAuthority(this.authority).assertReady();
    const rows = this.authority.db.prepare(`${POPULATION} ${summarySelect}
      ${excludeRecommendations ? "WHERE NOT EXISTS (SELECT 1 FROM personal_recommendations r WHERE r.recommendation_id=v.task_id)" : ""}
      ORDER BY latest_at DESC,task_id LIMIT ?`).all(limit) as SummaryRow[];
    return rows.map(decode);
  }

  activeCount(excludeRecommendations = false): number {
    new MemoryProjectionAuthority(this.authority).assertReady();
    const row = this.authority.db.prepare(`${POPULATION} SELECT COUNT(*) AS count FROM visible v
      WHERE state NOT IN (${settledSql}) ${excludeRecommendations
        ? "AND NOT EXISTS (SELECT 1 FROM personal_recommendations r WHERE r.recommendation_id=v.task_id)" : ""}`).get() as { count: number };
    return row.count;
  }

  /** summarySql is a trusted internal SELECT over personal_recommendations r. */
  recommendationRows(summarySql: string): IterableIterator<unknown> {
    new MemoryProjectionAuthority(this.authority).assertReady();
    return this.authority.db.prepare(`${POPULATION} ${summarySql}
      WHERE r.recommendation_id NOT IN blocked_ids AND NOT EXISTS (
        SELECT 1 FROM normalized n WHERE n.task_id=r.recommendation_id
          AND NOT EXISTS (SELECT 1 FROM visible v WHERE v.task_id=n.task_id)
      ) ORDER BY r.recommendation_id`).iterate();
  }

  find(id: string): TaskTimelineSummary | undefined {
    new MemoryProjectionAuthority(this.authority).assertReady();
    const row = this.authority.db.prepare(`${POPULATION} ${summarySelect} WHERE task_id=? OR task_id IN
      (SELECT MIN(task_id) FROM aliases WHERE alias_id=? HAVING COUNT(DISTINCT task_id)=1)
      ORDER BY (task_id=?) DESC,task_id LIMIT 1`).get(id, id, id) as SummaryRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  isSuppressed(id: string): boolean {
    const projections = new MemoryProjectionAuthority(this.authority);
    if (projections.isProjectionIdSuppressed(id)) return true;
    return this.authority.db.prepare(`${POPULATION} SELECT 1 FROM aliases a
      WHERE a.alias_id=? AND NOT EXISTS (SELECT 1 FROM visible v WHERE v.task_id=a.task_id) LIMIT 1`).get(id) !== undefined;
  }
}
