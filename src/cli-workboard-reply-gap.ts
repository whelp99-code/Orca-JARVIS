import { readFileSync } from "node:fs";
import { JarvisError } from "./db.js";
import type { CliCommandContext } from "./cli-command-context.js";
import { projectMailReplyGaps, type ReplyGapSnapshot } from "./workboard/adapters/mail-reply-gap.js";
import { WorkboardStore } from "./workboard/store.js";

function snapshotFrom(path: string): ReplyGapSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new JarvisError("MAIL_REPLY_GAP_SNAPSHOT_INVALID"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new JarvisError("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  const value = parsed as Record<string, unknown>;
  if (value.schema !== 1 || typeof value.observedAt !== "string" || (value.baseUrl !== undefined && typeof value.baseUrl !== "string") || !Array.isArray(value.open)) {
    throw new JarvisError("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  }
  return {
    observedAt: value.observedAt,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
    open: value.open as ReplyGapSnapshot["open"],
  };
}

/** `workboard ingest-reply-gap FILE --db PATH` — collector ingest, not a dashboard write route. */
export async function tryExecuteWorkboardReplyGap(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "workboard" || context.subcommand !== "ingest-reply-gap") return undefined;
  if (!context.argument || !context.values.db || context.positionals.length !== 3) throw new JarvisError("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  try {
    const result = projectMailReplyGaps(new WorkboardStore(context.db.db), snapshotFrom(context.argument));
    return { ok: true, command: "workboard.ingest-reply-gap", ...result };
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    const code = error instanceof Error && error.message.startsWith("MAIL_REPLY_GAP_") ? error.message : "MAIL_REPLY_GAP_SNAPSHOT_INVALID";
    throw new JarvisError(code);
  }
}
