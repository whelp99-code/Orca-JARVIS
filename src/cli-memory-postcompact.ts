import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readProcessStdin } from "./cli-host-memory.js";
import type { CliCommandContext } from "./cli-command-context.js";
import { jsonFile } from "./cli-command-input.js";
import { JarvisError } from "./db.js";
import { assembleDispatchContext } from "./cli-gjc-dispatch-assemble.js";

function parsePostCompactEvent(raw: unknown): { session_id: string; query: string; event_digest: string } {
  if (raw === null || typeof raw !== "object") throw new JarvisError("HOOK_JSON_INVALID");
  const payload = raw as Record<string, unknown>;
  const name = payload.hook_event_name ?? payload.hookEventName;
  switch (name) {
    case "PostCompact":
      break;
    default:
      throw new JarvisError("HOOK_EVENT_UNSUPPORTED");
  }
  const sessionId = payload.session_id;
  const query = payload.query ?? payload.compact_summary;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new JarvisError("HOOK_SESSION_MISSING");
  if (typeof query !== "string" || query.trim().length === 0) throw new JarvisError("HOOK_QUERY_MISSING");
  const trimmed = query.trim();
  const occurrence = occurrenceId(payload);
  const event_digest = `sha256:${createHash("sha256").update(`${sessionId}\0${occurrence}\0${trimmed}`).digest("hex")}`;
  return { session_id: sessionId, query: trimmed, event_digest };
}

function occurrenceId(payload: Record<string, unknown>): string {
  const keys = ["prompt_id", "promptId", "compaction_id", "compactionId", "event_id", "eventId", "uuid"] as const;
  const parts: string[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) parts.push(`${key}=${value}`);
  }
  return parts.join("\0");
}

/** Claude PostCompact (or same JSON) → existing reader reselect → configured model_transport. */
export async function executeMemoryPostcompact(
  context: CliCommandContext,
): Promise<Record<string, unknown>> {
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  if (options.model_transport === undefined) throw new JarvisError("MEMORY_MODEL_TRANSPORT_REQUIRED");
  let raw: unknown;
  if (context.argument !== undefined) {
    raw = await jsonFile(context.argument);
  } else {
    const read = context.dependencies.readStdin ?? readProcessStdin;
    try {
      raw = JSON.parse(Buffer.from(await read()).toString("utf8")) as unknown;
    } catch (error) {
      throw new JarvisError("HOOK_JSON_INVALID", error instanceof Error ? error.message : "HOOK_JSON_INVALID");
    }
  }
  const event = parsePostCompactEvent(raw);
  const ledger = postcompactLedgerPath(context);
  const seen = readPostcompactLedger(ledger);
  if (seen.includes(event.event_digest)) {
    return {
      ok: true,
      command: "memory.postcompact",
      duplicate: true,
      transport: "configured",
      event_digest: event.event_digest,
    };
  }
  const assembled = await assembleDispatchContext(context, {
    assemble_context: { query: event.query, purpose: "postcompact-reselect" },
    memory_evidence: [],
    task: { session_id: event.session_id },
  });
  if (assembled === undefined) throw new JarvisError("MEMORY_POSTCOMPACT_ASSEMBLE_MISSING");
  writePostcompactLedger(ledger, [...seen, event.event_digest]);
  return {
    ok: true,
    command: "memory.postcompact",
    model_session_id: assembled.capture.session_id,
    model_request_bytes: assembled.capture.bytes,
    transport: "configured",
    event_digest: event.event_digest,
  };
}

function postcompactLedgerPath(context: CliCommandContext): string {
  const envPath = process.env["JARVIS_POSTCOMPACT_LEDGER"];
  if (envPath !== undefined && envPath.length > 0) return envPath;
  return `${context.db.filename}.postcompact-events.json`;
}

function readPostcompactLedger(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writePostcompactLedger(path: string, events: readonly string[]): void {
  writeFileSync(path, `${JSON.stringify(events)}\n`);
}
