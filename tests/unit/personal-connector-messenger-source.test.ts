import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessengerPersonalConnectorSource, parseMessengerConnectorConfig } from "../../src/personal-connector-messenger-source.js";
import { createPersonalConnectorRegistry } from "../../src/personal-connectors.js";
import { CONNECTOR_NOW, connectorHarness, connectorSessionRequest } from "../fixtures/personal-connector-sources.js";

const uid = process.getuid?.() ?? -1;
if (uid < 0) throw new Error("POSIX_REQUIRED");
let root: string;
let file: string;
const summary = { schema_version: 1, observed_at: CONNECTOR_NOW.toISOString(),
  incomplete_count: 2, oldest_incomplete_age_ms: 120_000 };
const request = { connector_id: "messenger", scopes: ["messenger.summary.read"],
  fields: ["incomplete_count", "oldest_incomplete_age_ms", "observed_at"] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-messenger-source-"));
  file = join(root, "summary.json");
  writeFileSync(file, JSON.stringify(summary), { mode: 0o640 });
  chmodSync(file, 0o640);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function source(producer_uid = uid) {
  return new MessengerPersonalConnectorSource({ snapshot_file: file, producer_uid });
}

describe("read-only messenger aggregate source", () => {
  it("advances oldest age only within the snapshot freshness window", async () => {
    // Given a trusted aggregate observed one minute ago.
    const now = new Date(CONNECTOR_NOW.getTime() + 60_000);
    // When the boundary snapshot is read.
    const snapshot = await source().read(now);
    // Then only count, elapsed age and observation cross the boundary.
    expect(snapshot).toMatchObject({ status: "current", values: {
      incomplete_count: 2, oldest_incomplete_age_ms: 180_000, observed_at: summary.observed_at,
    } });
    expect(Object.keys(snapshot.values).sort()).toEqual(request.fields.slice().sort());
  });

  it("distinguishes a complete empty aggregate from unavailable input", async () => {
    // Given an explicitly empty producer result.
    writeFileSync(file, JSON.stringify({ ...summary, incomplete_count: 0, oldest_incomplete_age_ms: null }));
    // When it is read.
    const snapshot = await source().read(CONNECTOR_NOW);
    // Then it is no_data, not a failed read with fabricated zero values.
    expect(snapshot).toMatchObject({ status: "no_data", values: {}, evidence_refs: [] });
  });

  it.each([-1, 60_001])("refuses future or expired observation offset %i", async offset => {
    // Given a future or expired producer observation relative to the clock.
    const now = new Date(CONNECTOR_NOW.getTime() + offset);
    // When/Then no valid aggregate is returned.
    await expect(source().read(now)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it.each([
    {}, { ...summary, incomplete_count: -1 }, { ...summary, incomplete_count: 1.5 },
    { ...summary, incomplete_count: 0 }, { ...summary, oldest_incomplete_age_ms: null },
    { ...summary, oldest_incomplete_age_ms: -1 }, { ...summary, oldest_incomplete_age_ms: Number.MAX_SAFE_INTEGER },
    { ...summary, observed_at: "invalid" }, { ...summary, payload: {} },
  ])("rejects malformed or private-field aggregate case %#", async invalid => {
    // Given an invalid boundary object, including an unexpected payload field.
    writeFileSync(file, JSON.stringify(invalid));
    // When/Then validation fails closed.
    await expect(source().read(CONNECTOR_NOW)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it.each([0o600, 0o644, 0o660])("refuses unsafe or incorrect snapshot mode %i", async mode => {
    // Given a file outside the exact0640 contract.
    chmodSync(file, mode);
    // When/Then no read succeeds.
    await expect(source().read(CONNECTOR_NOW)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it("refuses an unexpected producer owner", async () => {
    // Given configuration that does not trust this file producer.
    const reader = source(uid + 1);
    // When/Then ownership is enforced, not just read access.
    await expect(reader.read(CONNECTOR_NOW)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it("refuses a group-writable publication directory", async () => {
    // Given a replaceable directory.
    chmodSync(root, 0o770);
    // When/Then a readable file alone is insufficient.
    await expect(source().read(CONNECTOR_NOW)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it("refuses a symlink snapshot", async () => {
    // Given a symlink to an otherwise valid file.
    const target = file;
    file = join(root, "link.json");
    symlinkSync(target, file);
    // When/Then no follow is permitted.
    await expect(source().read(CONNECTOR_NOW)).rejects.toMatchObject({ code: "MESSENGER_READ_REFUSED" });
  });

  it.each(["missing", "oversized", "invalid_json"])("refuses %s snapshots without leaking input", async kind => {
    // Given missing, oversized or invalid data.
    if (kind === "missing") rmSync(file);
    else writeFileSync(file, kind === "oversized" ? " ".repeat(4097) : "{");
    // When/Then only a fixed public code is exposed.
    await expect(source().read(CONNECTOR_NOW)).rejects.toMatchObject({
      code: "MESSENGER_READ_REFUSED", message: "MESSENGER_READ_REFUSED",
    });
  });

  it("rejects relative paths and absent producer binding at configuration time", () => {
    // Given untrusted boundary configuration, when parsed, then reject it.
    expect(() => parseMessengerConnectorConfig({ snapshot_file: "relative", producer_uid: uid }))
      .toThrow("MESSENGER_READ_CONFIG_INVALID");
    expect(() => parseMessengerConnectorConfig({ snapshot_file: file })).toThrow("MESSENGER_READ_CONFIG_INVALID");
  });

  it("keeps repeated messenger reads stateless while all legacy slots are occupied", async () => {
    // Given four live legacy checkpoints and a configured messenger snapshot.
    const harness = await connectorHarness();
    try {
      const registry = createPersonalConnectorRegistry({ ...harness.factory_input,
        messenger: { snapshot_file: file, producer_uid: uid } });
      const ids = ["second_brain", "orca", "task_timeline", "portfolio"] as const;
      const legacy = await Promise.all(ids.map(id => registry.inspect(connectorSessionRequest(id))));
      // When repeatedly reading messenger with explicit start/continue requests.
      for (let index = 0; index < 100; index += 1) {
        const checkpoint_session = index % 2 === 0 ? { mode: "start", version: 1 }
          : { mode: "continue", version: 1,
            handle: "pcp:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002" };
        const result = await registry.inspect({ ...request, checkpoint_session });
        expect(result).toMatchObject({ state: "ready", freshness: "fresh", checkpoint: null,
          values: { incomplete_count: 2, oldest_incomplete_age_ms: 120_000 },
          checkpoint_session: { mode: "stateless", handle: null } });
      }
      // Then the original legacy handles still work.
      for (const [index, id] of ids.entries()) {
        const checkpoint = legacy[index]?.checkpoint;
        expect(checkpoint).toBeTypeOf("string");
        const result = await registry.inspect(connectorSessionRequest(id, checkpoint ?? undefined));
        expect(result.checkpoint).toBe(checkpoint);
      }
      const subset = await registry.inspect({ ...request, fields: ["incomplete_count"] });
      expect(subset.values).toEqual({ incomplete_count: 2 });
      await expect(registry.inspect({ ...request, fields: ["payload"] })).rejects
        .toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
      await expect(registry.inspect({ ...request, checkpoint_session: { mode: "continue", version: 1, handle: "bad" } }))
        .rejects.toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
      rmSync(file);
      expect(await registry.inspect(request)).toMatchObject({ state: "unavailable", values: {}, checkpoint: null });
      expect(await harness.registry.inspect({ connector_id: "messenger", scopes: [], fields: [] }))
        .toMatchObject({ configured: false, reason: "not_configured" });
    } finally {
      harness.db.close();
      rmSync(dirname(harness.db.filename), { recursive: true, force: true });
    }
  });
});
