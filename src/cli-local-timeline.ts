import { statSync } from "node:fs";
import { commandNow, type CliCommandContext, type CliValues } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import { LocalTimelineSnapshotStore } from "./local-timeline-snapshot-store.js";
const actions = ["register", "collect", "snapshot", "hold", "release", "expire"];
export function localTimelinePreflight(positionals: readonly string[], values: CliValues): boolean {
  if (positionals[0] !== "timeline" || !actions.includes(positionals[1] ?? "")) return false;
  const action = positionals[1];
  if (!values.db || Object.entries(values).some(([key, value]) => value !== undefined && !["db", "json"].includes(key))
    || positionals.length !== (action === "expire" ? 2 : action === "snapshot" ? 4 : 3)
    || (action !== "expire" && !/^[A-Za-z0-9:._/-]{1,256}$/.test(positionals[2] ?? ""))
    || (action === "snapshot" && !/^collection:[0-9a-f-]{36}$/.test(positionals[3] ?? ""))) {
    throw new JarvisError("LOCAL_COLLECTION_INPUT_INVALID");
  }
  try { if (!statSync(values.db).isFile()) throw new Error(); }
  catch { throw new JarvisError("LOCAL_COLLECTION_DATABASE_UNAVAILABLE"); }
  return true;
}

export async function executeLocalTimeline(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (!localTimelinePreflight(context.positionals, context.values)) return undefined;
  const store = new LocalTimelineSnapshotStore(context.db, () => commandNow(context));
  const base = { ok: true, command: `timeline.${context.subcommand}`, source_kind: "local_task_timeline" };
  switch (context.subcommand) {
    case "register": store.register(context.argument!); return { ...base, task_id: context.argument, registered: true };
    case "collect": return { ...base, snapshot: store.refresh(context.argument!) };
    case "snapshot": return { ...base, result: store.read(context.argument!, context.fourth!) };
    case "hold": case "release": {
      const held = context.subcommand === "hold";
      store.setHeld(context.argument!, held); return { ...base, task_id: context.argument, held };
    }
    case "expire": return { ...base, expired_snapshots: store.expire() };
    default: throw new JarvisError("LOCAL_COLLECTION_INPUT_INVALID");
  }
}
