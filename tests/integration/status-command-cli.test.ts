import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { CLI_HELP } from "../../src/cli-help-text.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

/**
 * Gap G1 of the jarvis-svc cutover: `--help` listed `status` among the commands, but the dispatcher
 * only answered it when `--json` was also passed, so the documented spelling returned
 * UNKNOWN_COMMAND. The CLI has one output format, so the flag cannot be what decides whether a
 * command exists.
 */
describe("status command", () => {
  it("prints the same report with and without --json, and help documents the flag", async () => {
    // Given
    const path = tempDb();
    const db = await migratedTestDatabase(path);
    db.close();

    // When
    const bare = await execute(["status", "--db", path]);
    const flagged = await execute(["status", "--json", "--db", path]);

    // Then
    expect(bare).toMatchObject({ ok: true, version: 1 });
    expect(bare).toEqual(flagged);
    expect(CLI_HELP).toContain("status --db PATH [--json]");
  });

  it("still refuses a status subcommand rather than reporting the authority", async () => {
    // Given
    const path = tempDb();
    const db = await migratedTestDatabase(path);
    db.close();

    // When / Then
    await expect(execute(["status", "nope", "--db", path])).rejects.toThrow("UNKNOWN_COMMAND");
  });
});
