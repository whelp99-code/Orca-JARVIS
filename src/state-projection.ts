import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalize } from "./canonical.js";
import { AuthorityDb } from "./db.js";
import { passiveCapabilityProbe, runDoctor } from "./doctor.js";
import type { CapabilityProbe } from "./capabilities.js";
import { projectRecommendations, type RecommendationReadProjection } from "./recommendation-projection.js";
import { TaskTimeline } from "./task-timeline.js";
import { assertRootIdentity, secureRoot, syncDirectory, syncFile } from "./secure-filesystem.js";

export interface CurrentStateProjection {
  schema_version: 1;
  generated_at: string;
  now: Record<string, unknown>;
  blocked: unknown[];
  decisions: unknown[];
  next_3: unknown[];
  workers: unknown[];
  risks: unknown[];
  recommendations: RecommendationReadProjection;
}

const table = (db: AuthorityDb, name: string): boolean => Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export interface CurrentStateOptions {
  exclude_control_request_id?: string;
  capabilityProbe?: CapabilityProbe;
}

export async function buildCurrentState(db: AuthorityDb, now = new Date(), options: CurrentStateOptions = {}): Promise<CurrentStateProjection> {
  const doctor = await runDoctor(db, now, options.capabilityProbe ?? passiveCapabilityProbe());
  const stateCounts = table(db, "work_projection") ? db.db.prepare("SELECT state,COUNT(*) AS count FROM work_projection GROUP BY state ORDER BY state").all() : [];
  const pendingReports = table(db, "live_supervisor_reports") && table(db, "live_supervisor_report_receipts") ? Number((db.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts a ON a.report_id=r.report_id WHERE a.report_id IS NULL").get() as { count: number }).count) : 0;
  const bindings = table(db, "live_supervisor_bindings") ? db.db.prepare("SELECT canonical_path,provider,terminal_id,session_id,incarnation_id,project_id FROM live_supervisor_bindings ORDER BY canonical_path,provider,terminal_id").all() : [];
  const blockedWork = table(db, "work_items") ? db.db.prepare("SELECT id,state,action,deadline FROM work_items WHERE state IN ('blocked','rejected') ORDER BY created_at,id").all() : [];
  const blockedEvidence = table(db, "negative_evidence") ? db.db.prepare("SELECT evidence_id,task_id,attempt_id,reason_code,evidence_digest,created_at FROM negative_evidence ORDER BY created_at DESC,evidence_id DESC LIMIT 3").all() : [];
  const blocked = [...blockedWork, ...blockedEvidence];
  const workDecisions = table(db, "work_items") ? db.db.prepare("SELECT id,action,deadline FROM work_items WHERE state='awaiting_decision' ORDER BY created_at,id").all() : [];
  const commandDecisions = table(db, "control_command_requests") ? db.db.prepare("SELECT request_id,action,action_level,expires_at FROM control_command_requests WHERE state='pending' ORDER BY requested_at,request_id").all() : [];
  const commandQueue = table(db, "control_command_requests") ? db.db.prepare("SELECT request_id,action,state,expires_at FROM control_command_requests WHERE state IN ('approved','claimed') AND (? IS NULL OR request_id<>?) ORDER BY requested_at,request_id LIMIT 3").all(options.exclude_control_request_id ?? null, options.exclude_control_request_id ?? null) : [];
  const gjcQueue = table(db, "gjc_intents") ? db.db.prepare("SELECT intent_id,kind,state,created_at FROM gjc_intents WHERE state IN ('pending','claimed','accepted','uncertain') ORDER BY created_at,intent_id LIMIT 3").all() : [];
  const workflowQueue = table(db, "workflow_runs") ? db.db.prepare("SELECT run_id,loop_id,state,current_node,updated_at FROM workflow_runs WHERE state NOT IN ('completed','failed','cancelled') ORDER BY updated_at,run_id LIMIT 3").all() : [];
  const taskTimelines = table(db, "control_command_requests") && table(db, "workflow_runs") ? new TaskTimeline(db).list(500) : [];
  const recommendations = table(db, "personal_recommendations")
    ? projectRecommendations(db.db, now.toISOString(), 100)
    : { generated_at: now.toISOString(), next_actions: [], owner_decisions_needed: [], conflicts: [], omissions: [], warnings: [] };
  const risks = [
    ...doctor.checks.filter(check => !check.ok).map(check => ({ name: check.name, code: check.code ?? "CHECK_FAILED", actual: check.actual, expected: check.expected })),
    ...recommendations.warnings,
  ];
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    now: { state_counts: stateCounts, pending_reports: pendingReports, bindings: bindings.length, doctor_ok: doctor.ok, task_timelines: taskTimelines.length, task_timelines_pending_approval: taskTimelines.filter(item => item.pending_approval).length },
    blocked,
    decisions: [...recommendations.owner_decisions_needed, ...workDecisions, ...commandDecisions],
    next_3: [...recommendations.next_actions, ...commandQueue, ...workflowQueue, ...gjcQueue].slice(0, 3),
    workers: bindings,
    risks,
    recommendations,
  };
}

export async function writeCurrentState(db: AuthorityDb, directory: string, now = new Date(), options: CurrentStateOptions = {}): Promise<{ generation: string; directory: string; json: string; markdown: string; projection: CurrentStateProjection }> {
  const projection = await buildCurrentState(db, now, options);
  const root = await secureRoot(directory);
  const generationsRoot = join(root.path, ".current-state");
  await mkdir(generationsRoot, { mode: 0o700 });
  const generation = `generation-${now.getTime()}-${randomUUID()}`;
  const generationDirectory = join(generationsRoot, generation);
  await mkdir(generationDirectory, { mode: 0o700 });
  const jsonPath = join(generationDirectory, "CURRENT_STATE.json");
  const markdownPath = join(generationDirectory, "CURRENT_STATE.md");
  const section = (name: string, value: unknown) => `## ${name}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
  const markdown = `# JARVIS Current State\n\nGenerated: ${projection.generated_at}\n\n${section("NOW", projection.now)}\n${section("BLOCKED", projection.blocked)}\n${section("DECISIONS", projection.decisions)}\n${section("NEXT 3", projection.next_3)}\n${section("WORKERS", projection.workers)}\n${section("RISKS", projection.risks)}`;
  try {
    await writeFile(jsonPath, `${canonicalize(projection)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(markdownPath, markdown, { mode: 0o600, flag: "wx" });
    await syncFile(jsonPath);
    await syncFile(markdownPath);
    await syncDirectory(generationDirectory);
    await assertRootIdentity(root);
    const pointer = join(generationsRoot, "current");
    const temporaryPointer = join(generationsRoot, `.current.${randomUUID()}`);
    await symlink(basename(generationDirectory), temporaryPointer);
    await rename(temporaryPointer, pointer);
    await syncDirectory(generationsRoot);
    return { generation, directory: generationDirectory, json: jsonPath, markdown: markdownPath, projection };
  } catch (error) {
    await rm(generationDirectory, { recursive: true, force: true });
    throw error;
  }
}
