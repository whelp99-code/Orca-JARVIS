import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const SOURCE = resolve(process.cwd(), "src");

function sources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

/** Which product files call a function, by name, including the file that defines it. */
function callers(symbol: string): readonly string[] {
  const pattern = new RegExp(`\\b${symbol}\\s*\\(`);
  return sources(SOURCE).filter(path => pattern.test(readFileSync(path, "utf8")))
    .map(path => relative(SOURCE, path)).sort();
}

/**
 * Production has one door, and this is what keeps it that way.
 *
 * `produceDailyRecommendation` takes a request whose fields a caller could simply declare - the
 * policy, the principle, the owner's decision, the candidates. That is safe only while the single
 * caller is the module that derives all of them from storage. A second caller would be a second
 * place where a recommendation could be asserted into existence rather than produced, so the barrel
 * may keep exporting it, but nothing inside the product may reach for it directly.
 */
it("keeps one door into daily production", () => {
  expect(callers("produceDailyRecommendation"))
    .toEqual(["personal-context-production.ts", "personal-daily-production.ts"]);
  expect(callers("produceStoredDailyRecommendation"))
    .toEqual(["daily-loop-morning-execution.ts", "personal-daily-production.ts"]);
});
