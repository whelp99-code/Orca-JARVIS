import { JarvisError } from "./db.js";

export interface RuntimeControlActionInput {
  action: string;
  action_level: number;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
}

export interface ControlActionDescriptor {
  action: string;
  minimum_level: number;
  executable: boolean;
}

export interface ControlActionValidationOptions {
  enforceMinimumLevel?: boolean;
  levelErrorCode?: string;
}

type Validator = (input: RuntimeControlActionInput) => void;
type Descriptor = ControlActionDescriptor & { validate: Validator };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function rejectUnexpected(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new JarvisError(code);
}

function requireString(value: Record<string, unknown>, key: string, code: string): string {
  const item = value[key];
  if (!nonempty(item)) throw new JarvisError(code);
  return item;
}

function optionalString(value: Record<string, unknown>, key: string, code: string): string | undefined {
  if (!(key in value)) return undefined;
  const item = value[key];
  if (!nonempty(item)) throw new JarvisError(code);
  return item;
}

function requireRecord(value: Record<string, unknown>, key: string, code: string): Record<string, unknown> {
  const item = value[key];
  if (!isRecord(item)) throw new JarvisError(code);
  return item;
}

function requireLocalTarget(target: Record<string, unknown>, allowed: readonly string[] = ["environment"]): void {
  rejectUnexpected(target, allowed, "CONTROL_TARGET_MISMATCH");
  if (target.environment !== "local") throw new JarvisError("CONTROL_TARGET_MISMATCH");
}

function validateOptionalLocalTarget(target: Record<string, unknown>, allowed: readonly string[]): void {
  rejectUnexpected(target, allowed, "CONTROL_TARGET_MISMATCH");
  if (target.environment !== undefined && target.environment !== "local") throw new JarvisError("CONTROL_TARGET_MISMATCH");
}

function requireOnlyArgs(args: Record<string, unknown>, allowed: readonly string[]): void { rejectUnexpected(args, allowed, "CONTROL_ARGS_MISMATCH"); }

function bindTarget(target: Record<string, unknown>, key: string, expected: unknown): void {
  if (!(key in target)) return;
  if (target[key] !== expected || !nonempty(target[key])) throw new JarvisError("CONTROL_TARGET_MISMATCH");
}

function bindTaskTarget(target: Record<string, unknown>, candidates: readonly unknown[]): void {
  if (!("task_id" in target)) return;
  if (!nonempty(target.task_id) || !candidates.some(candidate => candidate === target.task_id)) throw new JarvisError("CONTROL_TARGET_MISMATCH");
}

function workflowTaskCandidates(args: Record<string, unknown>): unknown[] {
  const input = isRecord(args.input) ? args.input : undefined;
  return [args.task_id, args.correlation_id, input?.task_id].filter(candidate => candidate !== undefined);
}

function databaseBackup(input: RuntimeControlActionInput): void {
  requireLocalTarget(input.target);
  requireOnlyArgs(input.args, ["destination"]);
  requireString(input.args, "destination", "CONTROL_ARGS_MISMATCH");
}

function databaseRestoreDrill(input: RuntimeControlActionInput): void {
  requireLocalTarget(input.target);
  requireOnlyArgs(input.args, ["source"]);
  requireString(input.args, "source", "CONTROL_ARGS_MISMATCH");
}

function stateProject(input: RuntimeControlActionInput): void {
  requireLocalTarget(input.target);
  requireOnlyArgs(input.args, []);
}

function runbookExecute(input: RuntimeControlActionInput): void {
  requireLocalTarget(input.target, ["environment", "runbook_id"]);
  requireOnlyArgs(input.args, ["runbook_id", "args"]);
  const runbookId = requireString(input.args, "runbook_id", "CONTROL_ARGS_MISMATCH");
  requireRecord(input.args, "args", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "runbook_id", runbookId);
}

function workflowRegister(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["environment", "loop_id"]);
  requireOnlyArgs(input.args, ["spec"]);
  const spec = requireRecord(input.args, "spec", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "loop_id", spec.loop_id);
}

function workflowStart(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["environment", "repository", "run_id", "loop_id", "correlation_id", "task_id"]);
  optionalString(input.target, "repository", "CONTROL_TARGET_MISMATCH");
  requireOnlyArgs(input.args, ["run_id", "loop_id", "correlation_id", "input", "budget"]);
  const runId = requireString(input.args, "run_id", "CONTROL_ARGS_MISMATCH");
  const loopId = requireString(input.args, "loop_id", "CONTROL_ARGS_MISMATCH");
  const correlationId = requireString(input.args, "correlation_id", "CONTROL_ARGS_MISMATCH");
  requireRecord(input.args, "budget", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "run_id", runId);
  bindTarget(input.target, "loop_id", loopId);
  bindTarget(input.target, "correlation_id", correlationId);
  bindTaskTarget(input.target, workflowTaskCandidates(input.args));
}

function workflowAdvance(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["environment", "run_id", "task_id"]);
  requireOnlyArgs(input.args, ["run_id", "outcome", "output", "evidence_digest", "task_id"]);
  const runId = requireString(input.args, "run_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "outcome", "CONTROL_ARGS_MISMATCH");
  optionalString(input.args, "evidence_digest", "CONTROL_ARGS_MISMATCH");
  optionalString(input.args, "task_id", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "run_id", runId);
  bindTaskTarget(input.target, workflowTaskCandidates(input.args));
}

function workflowCancel(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["environment", "run_id", "task_id"]);
  requireOnlyArgs(input.args, ["run_id", "reason", "task_id"]);
  const runId = requireString(input.args, "run_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "reason", "CONTROL_ARGS_MISMATCH");
  optionalString(input.args, "task_id", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "run_id", runId);
  bindTaskTarget(input.target, workflowTaskCandidates(input.args));
}

function gitPush(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["task_id", "repository", "branch"]);
  requireOnlyArgs(input.args, ["task_id", "branch"]);
  const taskId = requireString(input.args, "task_id", "CONTROL_ARGS_MISMATCH");
  const branch = requireString(input.args, "branch", "CONTROL_ARGS_MISMATCH");
  bindTarget(input.target, "task_id", taskId);
  bindTarget(input.target, "branch", branch);
}

function retiredCollaborationRoomCreate(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["task_id"]);
  requireOnlyArgs(input.args, ["room"]);
  requireRecord(input.args, "room", "CONTROL_ARGS_MISMATCH");
}

function evidenceNegativeRecord(input: RuntimeControlActionInput): void {
  validateOptionalLocalTarget(input.target, ["environment", "task_id"]);
  requireOnlyArgs(input.args, ["schema_version", "task_id", "attempt_id", "reason_code", "scope", "summary", "evidence_digest"]);
  const taskId = requireString(input.args, "task_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "attempt_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "reason_code", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "summary", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "evidence_digest", "CONTROL_ARGS_MISMATCH");
  if (input.args.schema_version !== 1 || !Array.isArray(input.args.scope)) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  bindTaskTarget(input.target, [taskId]);
}

const descriptors: Record<string, Descriptor> = {
  "database.backup": { action: "database.backup", minimum_level: 2, executable: true, validate: databaseBackup },
  "database.restore_drill": { action: "database.restore_drill", minimum_level: 1, executable: true, validate: databaseRestoreDrill },
  "state.project": { action: "state.project", minimum_level: 1, executable: true, validate: stateProject },
  "workflow.register": { action: "workflow.register", minimum_level: 3, executable: true, validate: workflowRegister },
  "workflow.start": { action: "workflow.start", minimum_level: 2, executable: true, validate: workflowStart },
  "workflow.advance": { action: "workflow.advance", minimum_level: 2, executable: true, validate: workflowAdvance },
  "workflow.cancel": { action: "workflow.cancel", minimum_level: 3, executable: true, validate: workflowCancel },
  "runbook.execute": { action: "runbook.execute", minimum_level: 1, executable: true, validate: runbookExecute },
  "git.push": { action: "git.push", minimum_level: 4, executable: false, validate: gitPush },
  "collaboration.room.create": { action: "collaboration.room.create", minimum_level: 3, executable: false, validate: retiredCollaborationRoomCreate },
  "evidence.negative.record": { action: "evidence.negative.record", minimum_level: 2, executable: true, validate: evidenceNegativeRecord },
};

export const KNOWN_CONTROL_ACTIONS = Object.freeze(Object.keys(descriptors).sort());

export function controlActionDescriptor(action: string): ControlActionDescriptor | undefined {
  const descriptor = descriptors[action];
  return descriptor ? { action: descriptor.action, minimum_level: descriptor.minimum_level, executable: descriptor.executable } : undefined;
}

export function validateControlAction(input: RuntimeControlActionInput, options: ControlActionValidationOptions = {}): ControlActionDescriptor {
  const descriptor = descriptors[input.action];
  if (!descriptor) throw new JarvisError("CONTROL_ACTION_UNKNOWN");
  if (!Number.isInteger(input.action_level) || input.action_level < 0 || input.action_level > 5) throw new JarvisError("CONTROL_COMMAND_INVALID");
  descriptor.validate(input);
  if (options.enforceMinimumLevel && input.action_level < descriptor.minimum_level) {
    throw new JarvisError(options.levelErrorCode ?? "CONTROL_ACTION_LEVEL_TOO_LOW");
  }
  return { action: descriptor.action, minimum_level: descriptor.minimum_level, executable: descriptor.executable };
}
