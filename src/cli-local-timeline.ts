import { admitLocalTimelineObservation } from "./local-timeline-observation.js";
import { readFileSync, statSync } from "node:fs";
import {
  parseLocalObservationRetentionConfig, resolveLocalObservationRetentionCutoff,
  selectLocalObservationRetention,
} from "./local-observation-retention-selection.js";
import { commandNow, type CliCommandContext, type CliValues } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import { LocalTimelineSnapshotStore } from "./local-timeline-snapshot-store.js";
const actions = ["register", "collect", "snapshot", "admit-observation", "subjects", "hold", "release",
  "expire", "retention-preview"];

/** Bounded read of the configuration document: this surface takes one closed two-field record. */
export function readRetentionConfig(path: string): unknown {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID"); }
}
export function localTimelinePreflight(positionals: readonly string[], values: CliValues): boolean {
  if (positionals[0] !== "timeline" || !actions.includes(positionals[1] ?? "")) return false;
  const action = positionals[1];
  const exactCollection = action === "snapshot" || action === "admit-observation";
  const noSubject = action === "expire" || action === "subjects";
  if (!values.db || Object.entries(values).some(([key, value]) => value !== undefined && !["db", "json"].includes(key))
    || positionals.length !== (noSubject ? 2 : exactCollection ? 4 : 3)
    || (!noSubject && !/^[A-Za-z0-9:._/-]{1,256}$/.test(positionals[2] ?? ""))
    || (exactCollection && !/^collection:[0-9a-f-]{36}$/.test(positionals[3] ?? ""))) {
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
    case "subjects": return { ...base, subjects: store.subjects() };
    case "register": store.register(context.argument!); return { ...base, task_id: context.argument, registered: true };
    case "collect": return { ...base, snapshot: store.refresh(context.argument!) };
    case "admit-observation": return { ...base, observation: admitLocalTimelineObservation(
      context.db, context.argument!, context.fourth!, () => commandNow(context)) };
    case "snapshot": return { ...base, result: store.read(context.argument!, context.fourth!) };
    case "hold": case "release": {
      const held = context.subcommand === "hold";
      store.setHeld(context.argument!, held); return { ...base, task_id: context.argument, held };
    }
    case "expire": return { ...base, expired_snapshots: store.expire() };
    case "retention-preview": {
      // Read-only: the configured window chooses a cutoff and the selector reports what it
      // would reach. Applying it is a separate rebuild that this command never performs.
      const config = parseLocalObservationRetentionConfig(readRetentionConfig(context.argument!));
      const cutoff = resolveLocalObservationRetentionCutoff(config, commandNow(context));
      return { ...base, retention: { retain_ms: config.retain_ms,
        ...selectLocalObservationRetention(context.db.db, cutoff) } };
    }
    default: throw new JarvisError("LOCAL_COLLECTION_INPUT_INVALID");
  }
}
