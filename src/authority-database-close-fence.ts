import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { authorityContentDigest, withAuthorityContentProbe } from "./authority-database-content.js";
import { releaseSwapBarrier } from "./authority-database-swap-barrier.js";
import { retirementState } from "./local-observation-retention-publish.js";

/** Caller holds the source's exclusive transaction and has finished all of its own writes. */
export function closeSourceWithContentFence(
  authority: AuthorityDb, prefix: "MEMORY" | "LOCAL_RETENTION",
): ReturnType<typeof retirementState> {
  try {
    const beforeClose = authorityContentDigest(authority.db);
    return withAuthorityContentProbe(authority.filename, probe => {
      // Initialize this reader under the source lock. Otherwise a healthy read would create
      // empty WAL/SHM files after the physical baseline and falsely look like a late commit.
      probe.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
      authority.close();
      // Fix physical evidence BEFORE the new logical snapshot. A later commit must not become
      // both baselines, including a write inside the probe's own native close.
      const physical = retirementState(authority.filename);
      let afterClose: string;
      try { afterClose = authorityContentDigest(probe); }
      catch { throw new JarvisError(`${prefix}_SOURCE_UNREADABLE_DURING_CLOSE`); }
      if (beforeClose !== afterClose) throw new JarvisError(`${prefix}_SOURCE_CHANGED_DURING_CLOSE`);
      return physical;
    });
  } catch (error) {
    if (authority.db.open && authority.db.inTransaction) authority.db.exec("ROLLBACK");
    releaseSwapBarrier(authority.filename);
    if (!authority.db.open) authority.reopen();
    throw error;
  }
}
