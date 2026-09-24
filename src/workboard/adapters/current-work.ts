import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { metadataEvent } from "./session-metadata.js";
import { sourceKey, type Source, type WorkEvent } from "../contracts.js";
import type { WorkboardStore } from "../store.js";

export type CurrentSource = { source: Source; directory: string; kind: "claude-live" | "current-manifest" };
export type CollectionResult = { source: string; coverage: "complete" | "unknown"; ingested: number; currentIds: string[]; reason?: string };
const MAX_FILES = 256;
const MAX_BYTES = 16 * 1024;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\r\n\0]/u.test(v);
const time = (v: unknown): string | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
};
function livePid(pid: unknown, start: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    // A PID alone can be recycled; when supplied, match the Linux process start tick as well.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return fields[0] !== "Z" && (start === undefined || String(start) === fields[19]);
  } catch { return false; }
}
function eventFor(value: unknown, config: CurrentSource, path: string, observedAt: string): WorkEvent | undefined {
  if (!record(value) || !text(value.sessionId) || !text(value.name ?? value.taskTitle) ||
    !time(value.updatedAt) || !livePid(value.pid, value.procStart) ||
    !["working", "running", "idle", "waiting", "blocked", "paused"].includes(String(value.status))) return undefined;
  if (config.kind === "current-manifest" && value.current !== true) return undefined;
  const state = value.status === "idle" || value.status === "waiting" ? "waiting" :
    value.status === "blocked" ? "blocked" : value.status === "paused" ? "paused" : "running";
  const sessionId = value.sessionId.replace(/\.history$/u, "");
  const sourceAt = time(value.updatedAt)!;
  const summary = value.name ?? value.taskTitle;
  return metadataEvent(config.source, { sessionId, incarnation: String(value.procStart ?? value.pid),
    eventId: `${sessionId}:${sourceAt}:${observedAt}`, sequence: Date.parse(observedAt),
    observedAt, sourceAt, state, summary: summary as string, evidenceRef: path });
}
/** Only explicit current-session metadata or a live Claude process is eligible.
 * Never scan transcript directories or infer currency from a file's mtime. */
export function collectCurrentWork(store: WorkboardStore, sources: CurrentSource[], observedAt: string): CollectionResult[] {
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("WORKBOARD_OBSERVATION_INVALID");
  return sources.map(config => {
    const source = sourceKey(config.source);
    try {
      if (!existsSync(config.directory)) return { source, coverage: "unknown", ingested: 0, currentIds: [], reason: "current metadata unavailable" };
      const files = config.kind === "claude-live" ? readdirSync(config.directory).filter(f => f.endsWith(".json")) : ["current.json"];
      if (files.length > MAX_FILES) throw new Error("current metadata exceeds file bound");
      const events: WorkEvent[] = [];
      for (const file of files) {
        if (config.kind === "current-manifest" && !existsSync(join(config.directory, file)))
          throw new Error("current manifest unavailable");
        const path = join(config.directory, file);
        if (!statSync(path).isFile() || statSync(path).size > MAX_BYTES) throw new Error("current metadata exceeds size bound");
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        const entries = config.kind === "current-manifest" && record(data) && Array.isArray(data.sessions) ? data.sessions : [data];
        if (entries.length > MAX_FILES) throw new Error("current metadata exceeds entry bound");
        for (const entry of entries) {
          const event = eventFor(entry, config, path, observedAt);
          if (event) events.push(event);
        }
      }
      // Reject an ambiguous snapshot before any ingest; repeated .history identities coalesce.
      const unique = new Map(events.map(event => [event.sessionId, event]));
      for (const event of unique.values()) store.ingest(event);
      return { source, coverage: "complete", ingested: unique.size, currentIds: [...unique.keys()] };
    } catch (error) {
      return { source, coverage: "unknown", ingested: 0, currentIds: [], reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Linux discovered locations: Claude has live PID metadata; other agents require an
 * explicit current.json manifest, not their historical session-file roster. */
export function linuxCurrentSources(home: string): CurrentSource[] {
  return [
    { source: { host: "linux", app: "codex", scope: "local", generation: "initial" }, directory: join(home, ".codex"), kind: "current-manifest" },
    { source: { host: "linux", app: "claude", scope: "local", generation: "initial" }, directory: join(home, ".claude", "sessions"), kind: "claude-live" },
    { source: { host: "linux", app: "omo", scope: "local", generation: "initial" }, directory: join(home, ".omp", "agent"), kind: "current-manifest" },
    { source: { host: "linux", app: "senpi", scope: "local", generation: "initial" }, directory: join(home, ".omo", "agent"), kind: "current-manifest" },
  ];
}
