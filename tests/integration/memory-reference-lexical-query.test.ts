import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { normalizeMemoryLexicalQuery } from "../../src/memory-reference-query.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { writeSecondBrainFixtureLauncher } from "../fixtures/second-brain-transport-harness.js";

const PROVIDER_CHILD = resolve(process.cwd(), "tests/fixtures/second-brain-mcp-child.mjs");
const PAGE = "wiki/next-steps";
// A record a real vault really holds: the answer is written with a colon, not with the question
// mark the question ends in.
const RECORD_TEXT = "What should happen next: finish the provider chain.";
const AT = new Date("2026-09-01T00:00:00.000Z");
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 32768 };

const databases: MemoryDatabase[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) closeMemoryDatabase(database);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The provider this deployment reads through: a real stdio child applying the lexical contract. */
async function provider(text: string) {
  const database = await memoryDatabase(); databases.push(database);
  const root = mkdtempSync(join(tmpdir(), "jarvis-lexical-query-")); roots.push(root);
  writeFileSync(join(root, "memory-projection.key"), randomBytes(32), { mode: 0o600 });
  const launcher = join(root, "second-brain-mcp");
  writeSecondBrainFixtureLauncher(launcher, PROVIDER_CHILD);
  const config = join(root, "provider-config.json");
  writeFileSync(config, JSON.stringify({ adapterScenario: "schema4", schema4LexicalQuery: true,
    schema4Pages: [{ page_id: PAGE, sensitivity: "personal", updated: "2026-08-31",
      records: [{ sid: "12345678", text, valid_from: "2026-08-31T00:00:00.000Z" }] }] }));
  const transport = createSecondBrainTransport({ launcherPath: launcher, configPath: config });
  const runtime = createProductionMemoryReference(database.authority,
    { clock: () => AT, transport, projection_key: Buffer.alloc(32, 7) });
  return { runtime, transport };
}

describe("a natural-language question against the provider's lexical contract", () => {
  it("reads the record a question with trailing punctuation asks about", async () => {
    const value = await provider(RECORD_TEXT);
    try {
      const reference = await value.runtime.reader.read("What should happen next?", BUDGETS);
      expect(reference.payload.records).toHaveLength(1);
      expect(reference.payload.records[0]?.text).toBe(RECORD_TEXT);
    } finally { await value.transport.close(); }
  }, 60_000);

  it("digests the question as asked, not the normalised terms", async () => {
    const value = await provider(RECORD_TEXT);
    try {
      const asked = await value.runtime.reader.read("What should happen next?", BUDGETS);
      const plain = await value.runtime.reader.read("What should happen next", BUDGETS);
      expect(asked.payload.records).toHaveLength(1);
      expect(asked.payload.query_digest).not.toBe(plain.payload.query_digest);
    } finally { await value.transport.close(); }
  }, 60_000);

  it("still returns nothing when a term the record does not contain is asked for", async () => {
    const value = await provider(RECORD_TEXT);
    try {
      const reference = await value.runtime.reader.read("What should happen yesterday?", BUDGETS);
      expect(reference.payload.records).toHaveLength(0);
      expect(reference.payload.state).toBe("empty");
    } finally { await value.transport.close(); }
  }, 60_000);
});

describe("lexical query normalisation", () => {
  it.each([
    ["What should happen next?", "What should happen next"],
    ["다음은 무엇입니까?", "다음은 무엇입니까"],
    ["next!  then, this.", "next then this"],
    ["  spaced   out  ", "spaced out"],
    ["plain terms", "plain terms"],
  ])("drops trailing punctuation from every term (%s)", (query, expected) => {
    expect(normalizeMemoryLexicalQuery(query)).toBe(expected);
  });
  it("keeps a term whose punctuation is not trailing", () => {
    expect(normalizeMemoryLexicalQuery("sb_search v1.2 a.b?")).toBe("sb_search v1.2 a.b");
  });
  it("leaves the provider's own quoted-phrase syntax exactly as written", () => {
    expect(normalizeMemoryLexicalQuery('"what should happen next?"'))
      .toBe('"what should happen next?"');
  });
  it("leaves a query that is only punctuation for the adapter to report", () => {
    expect(normalizeMemoryLexicalQuery("???")).toBe("???");
  });
});
