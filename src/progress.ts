import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";
import type { ProgressAssessment, ProgressBatch, ProgressState, ProgressTransitionEvidence } from "./types.js";

const states = new Set<ProgressState>(["running", "needs_input", "approval_required", "verifying", "stopped", "unknown"]);
const providers = new Set(["codex", "claude"]);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const invalid = (): never => { throw new JarvisError("PROGRESS_INPUT_INVALID"); };
const object = (value: unknown): Record<string, unknown> | never => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(); };
const validString = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.normalize("NFC") === value && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= max;

export function isRfc3339Millis(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assessment(value: unknown): ProgressAssessment {
  const input = object(value); exactKeys(input, ["provider", "terminal_id", "incarnation_id", "cursor", "observation_identity", "state"]);
  if (!providers.has(input.provider as string) || !validString(input.terminal_id, 256) || !validString(input.incarnation_id, 256) || (input.cursor !== null && !validString(input.cursor, 256)) || typeof input.observation_identity !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.observation_identity) || !states.has(input.state as ProgressState)) invalid();
  return { provider: input.provider as ProgressAssessment["provider"], terminal_id: input.terminal_id as string, incarnation_id: input.incarnation_id as string, cursor: input.cursor as string | null, observation_identity: input.observation_identity as string, state: input.state as ProgressState };
}

export function parseProgressBatch(value: unknown): ProgressBatch {
  const input = object(value); exactKeys(input, ["version", "worktree", "observed_at", "assessments"]);
  if (input.version !== 1 || !validString(input.worktree, 4096) || !isRfc3339Millis(input.observed_at) || !Array.isArray(input.assessments) || input.assessments.length < 1 || input.assessments.length > 1000) invalid();
  const assessments = (input.assessments as unknown[]).map(assessment); const terminals = new Set(assessments.map(item => item.terminal_id)); if (terminals.size !== assessments.length) invalid();
  return { version: 1, worktree: input.worktree as string, observed_at: input.observed_at as string, assessments };
}

const compare = (left: Pick<ProgressTransitionEvidence, "provider" | "terminal_id" | "incarnation_id">, right: Pick<ProgressTransitionEvidence, "provider" | "terminal_id" | "incarnation_id">): number => left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : left.terminal_id < right.terminal_id ? -1 : left.terminal_id > right.terminal_id ? 1 : left.incarnation_id < right.incarnation_id ? -1 : left.incarnation_id > right.incarnation_id ? 1 : 0;

function transition(value: ProgressTransitionEvidence): void {
  if (!providers.has(value.provider) || !validString(value.terminal_id, 256) || !validString(value.incarnation_id, 256) || (value.cursor !== null && !validString(value.cursor, 256)) || !states.has(value.to) || (value.from !== null && !states.has(value.from)) || !/^sha256:[0-9a-f]{64}$/.test(value.observation_identity)) invalid();
}

export function serializeProgressReport(worktree: string, observedAt: string, transitions: readonly ProgressTransitionEvidence[]): { report_id: string; payload_json: string; payload_digest: string } {
  if (!validString(worktree, 4096) || !isRfc3339Millis(observedAt) || transitions.length === 0) invalid();
  for (let index = 0; index < transitions.length; index++) { transition(transitions[index]!); if (index > 0 && compare(transitions[index - 1]!, transitions[index]!) > 0) invalid(); }
  const preimage = JSON.stringify(["progress/v1", worktree, transitions.map(item => [item.provider, item.terminal_id, item.incarnation_id, item.cursor, item.from, item.to, item.observation_identity])]);
  const report_id = `progress_${digest(preimage)}`;
  const payload_json = JSON.stringify({ version: 1, report_id, worktree, observed_at: observedAt, transitions: transitions.map(item => ({ provider: item.provider, terminal_id: item.terminal_id, incarnation_id: item.incarnation_id, cursor: item.cursor, from: item.from, to: item.to })) });
  return { report_id, payload_json, payload_digest: `sha256:${digest(payload_json)}` };
}
