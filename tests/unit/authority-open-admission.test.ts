import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every connection to a live authority database goes through admission, or it is one of the
 * openings below that is not a live authority database at all. The list is the contract: a new
 * opening that is neither admitted nor named here is an unregistered connection, which is exactly
 * what a swap cannot exclude, and this fails until it is one or the other.
 */
const NOT_A_LIVE_AUTHORITY: Readonly<Record<string, string>> = {
  "authority-database-swap-lock.ts": "the swap's own lock file, not a database anyone else uses",
  "local-observation-retention-operation.ts": "the candidate being built, which is not live yet",
  "local-observation-retention-swap.ts": "the swap's lock probe, taken while it holds the barrier",
  "personal-os-backup.ts": "the backup copy at the destination path, never the source",
};

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
    .map(entry => join(entry.parentPath, entry.name));
}

describe("authority open admission", () => {
  it("opens a live authority only through admission, and names every opening that is not one", () => {
    const root = join(import.meta.dirname, "..", "..", "src");
    const unadmitted: string[] = [];
    for (const path of sources(root)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("new Database(")) return;
        const context = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
        if (context.includes("openUnderSwapAdmission(")) return;
        unadmitted.push(`${path.slice(root.length + 1)}:${index + 1}`);
      });
    }
    const unnamed = unadmitted.filter(site =>
      !Object.keys(NOT_A_LIVE_AUTHORITY).some(file => site.startsWith(file)));
    expect(unnamed).toEqual([]);
    // The named ones are still there: this is an enumeration, not a suppression, so a file that
    // stops opening a database at all has to leave the list with it.
    for (const file of Object.keys(NOT_A_LIVE_AUTHORITY)) {
      expect(unadmitted.some(site => site.startsWith(file))).toBe(true);
    }
  });
});
