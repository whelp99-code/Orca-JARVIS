/** Correlated to command alias c; bounded traversal uses request primary keys.
 * Includes the request's own task scope and all permitted ancestors. */
export const CONTROL_LINEAGE_VISIBLE_SQL = `NOT EXISTS (
  WITH RECURSIVE ancestors(request_id,args_json,target_json,depth) AS (
    SELECT c.request_id,c.args_json,c.target_json,0 WHERE c.action='task.execute'
    UNION ALL
    SELECT p.request_id,p.args_json,p.target_json,a.depth+1
    FROM ancestors a JOIN control_command_requests p
      ON p.request_id=json_extract(a.args_json,'$.work_lineage.prior_request_id')
    WHERE a.depth<63 AND p.action='task.execute'
      AND json_extract(a.args_json,'$.work_lineage.kind') IN ('rework','retry')
  )
  SELECT 1 FROM ancestors a WHERE (
    EXISTS (SELECT 1 FROM memory_projection_quarantine q
      WHERE (q.projection_kind='control_payload' AND q.projection_id=a.request_id AND q.component_id=a.request_id)
        OR q.projection_id=json_extract(a.target_json,'$.task_id'))
    OR EXISTS (SELECT 1 FROM memory_projection_suppressions s
      WHERE (s.projection_kind='control_payload' AND s.projection_id=a.request_id AND s.component_id=a.request_id)
        OR s.projection_id=json_extract(a.target_json,'$.task_id'))
  )
)`;
