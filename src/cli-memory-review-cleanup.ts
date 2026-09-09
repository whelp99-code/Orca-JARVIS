import { isAbsolute } from "node:path";
import type { CliCommandContext } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import { inspectPrivateSpoolRoot } from "./memory-private-spool-files.js";
import { MemoryReviewCleanupScanner } from "./memory-review-cleanup-scanner.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV } from "./personal-os-cycle-channel.js";

export function configuredMemoryReviewCleanup(context: CliCommandContext) {
  const root = context.values["memory-review-cleanup-root"];
  const rawLimit = context.values["memory-review-cleanup-limit"];
  if (root === undefined && rawLimit === undefined) return undefined;
  const limit = rawLimit === undefined ? 64 : Number(rawLimit);
  if (context.command !== "service" || !["once", "run"].includes(context.subcommand ?? "")
    || root === undefined || !isAbsolute(root) || process.env[PERSONAL_OS_CONTROL_CHANNEL_ENV]
    || (rawLimit !== undefined && !/^[1-9][0-9]{0,3}$/.test(rawLimit))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new JarvisError("MEMORY_REVIEW_CLEANUP_CONFIG_INVALID");
  }
  // Require an existing private root; configuring cleanup must not create or repair a directory.
  let existingRoot;
  try { existingRoot = inspectPrivateSpoolRoot(root); }
  catch { throw new JarvisError("MEMORY_REVIEW_CLEANUP_CONFIG_INVALID"); }
  const scanner = new MemoryReviewCleanupScanner(context.db, root, existingRoot);
  return {
    cycle(now: Date) {
      try {
        const batch = scanner.cycle(now, limit);
        return { status: batch.failed > 0 ? "partial" : "processed", ...batch };
      } catch { return { status: "error", code: "MEMORY_REVIEW_CLEANUP_FAILED" }; }
    },
    close() { scanner.close(); },
  };
}
