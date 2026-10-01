export type Source = { host: string; app: string; scope: string; generation: string };
export type SessionRelation = { source: Source; sessionId: string };
export type WorkEvent = {
  source: Source; eventId: string; sequence: number; sessionId: string; incarnation: string;
  taskId: string | null; receivedAt: string; sourceAt: string;
  state: "running" | "waiting" | "blocked" | "failed" | "paused" | "claimed_done" | "verified" | "unknown";
  summary: string; evidenceRef: string; repo?: string; pid?: number; title?: string;
  parent?: SessionRelation; alias?: SessionRelation;
};
export const sourceKey = (s: Source): string => `${s.host}:${s.app}:${s.scope}:${s.generation}`;
export const sessionKey = (s: Source, id: string): string => JSON.stringify([sourceKey(s), id]);
export const workKey = (session: string, taskId: string | null): string => JSON.stringify([session, taskId === null ? "current" : `task:${taskId}`]);
export const attemptKey = (session: string, incarnation: string): string => JSON.stringify([session, incarnation]);
const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\0\r\n]/u.test(v);
const sourceValid = (value: unknown): value is Source => typeof value === "object" && value !== null &&
  ["host", "app", "scope", "generation"].every(k => token((value as Record<string, unknown>)[k]));
const relationValid = (value: unknown): value is SessionRelation => typeof value === "object" && value !== null &&
  sourceValid((value as SessionRelation).source) && token((value as SessionRelation).sessionId);
export function validateEvent(value: unknown): asserts value is WorkEvent {
  const v = value as Partial<WorkEvent> | null;
  if (!v || !sourceValid(v.source) || !token(v.eventId) || !Number.isSafeInteger(v.sequence) || v.sequence! < 0 ||
    !token(v.sessionId) || !token(v.incarnation) || (v.taskId !== null && !token(v.taskId)) ||
    !token(v.summary) || v.summary.length > 512 || !token(v.evidenceRef) ||
    !["running", "waiting", "blocked", "failed", "paused", "claimed_done", "verified", "unknown"].includes(v.state ?? "") ||
    !v.receivedAt || !v.sourceAt || !Number.isFinite(Date.parse(v.receivedAt)) || !Number.isFinite(Date.parse(v.sourceAt)) ||
    (v.parent !== undefined && !relationValid(v.parent)) || (v.alias !== undefined && !relationValid(v.alias))) throw new Error("WORKBOARD_EVENT_INVALID");
}
