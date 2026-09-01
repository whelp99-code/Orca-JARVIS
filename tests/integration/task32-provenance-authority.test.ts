import { describe, expect, it } from "vitest";
import { createMemoryRuntime } from "../../src/dashboard/memory-runtime.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { AuthorityDb } from "../../src/db.js";
import type { SecondBrainReadAdapter } from "../../src/second-brain-adapter-types.js";
import { TASK32_NOW, Task32ReadAdapter } from "../fixtures/task32-memory-test-support.js";
import { tempDb } from "../helpers.js";

function schema3Adapter(): SecondBrainReadAdapter {
  const reader = new Task32ReadAdapter();
  return { contract_profile: "schema3-read-only",
    search: () => reader.search(), readPage: page => reader.readPage(page),
    recentChanges: () => reader.recentChanges(), openConflicts: () => reader.openConflicts() };
}

describe("Task 32 provider profile authority", () => {
  it("keeps exact schema 3 read-only and enables staging only for schema 4", async () => {
    // Given
    const authority = new AuthorityDb(tempDb()); await authority.migrate();
    const common = { authority, session: createDashboardSession("owner-session"),
      clock: () => TASK32_NOW, projection_key: Buffer.alloc(32, 4) };
    // When
    const schema3 = createMemoryRuntime({ ...common, adapter: schema3Adapter() });
    const schema4 = createMemoryRuntime({ ...common, adapter: new Task32ReadAdapter() });
    // Then
    expect(schema3.read.status()).toMatchObject({ state: "ready", mutations_enabled: false, contract_schema: 3 });
    expect(schema3.mutation).toBeUndefined();
    expect(schema4.read.status()).toMatchObject({ state: "ready", mutations_enabled: true, contract_schema: 4 });
    expect(schema4.mutation).toBeDefined();
    authority.close();
  });
});
