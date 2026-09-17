import { dirname, isAbsolute, join } from "node:path";
import { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import { LocalObservationRetentionService } from "./local-observation-retention-service.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV } from "./personal-os-cycle-channel.js";

/**
 * The window the scheduled lane opens in. The service fences its own cycle against this, so the
 * caller may ask on every tick and still get one attempt per window. It is a constant rather than a
 * flag: a destructive rebuild earns no second knob, and the retained span is already the operator's
 * to choose in the configuration document.
 */
export const LOCAL_RETENTION_INTERVAL_MS = 6 * 3_600_000;
const REGISTRY_DIRECTORY = "authority-registry";

/**
 * `--local-retention-config PATH` is the only way the destructive local-observation lane runs.
 * Unset is off: no runtime is built, this process registers nothing, and the lane cannot be reached
 * at all. Set is load-bearing - a path that is not absolute, a command that is not `service
 * once|run`, or a control-channel cycle fails closed here rather than inside a swap.
 */
export function configuredLocalRetention(context: CliCommandContext) {
  const config = context.values["local-retention-config"];
  if (config === undefined) return undefined;
  if (context.command !== "service" || !["once", "run"].includes(context.subcommand ?? "")
    || !isAbsolute(config) || process.env[PERSONAL_OS_CONTROL_CHANNEL_ENV]) {
    throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID");
  }
  // Beside the database it describes, because the registry is keyed by that database's filename.
  const runtime = new AuthorityDatabaseRuntime(context.db, {
    registry_root: join(dirname(context.db.filename), REGISTRY_DIRECTORY), watchdog_ms: 5_000 });
  const service = new LocalObservationRetentionService(context.db, {
    config_path: config, runtime, interval_ms: LOCAL_RETENTION_INTERVAL_MS,
    clock: () => commandNow(context) });
  return {
    async cycle() {
      try { return await service.cycle(); }
      catch { return { status: "failed", code: "LOCAL_RETENTION_CYCLE_FAILED", recovered: [] }; }
    },
    // Only this process's registry record. The database is the caller's and outlives the lane.
    close() { runtime.releaseRegistry(); },
  };
}
