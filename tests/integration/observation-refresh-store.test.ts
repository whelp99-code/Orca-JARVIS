import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { ObservationRefreshStore } from "../../src/observation-refresh-store.js";
import { observationInput, OBSERVATION_CHECKED_AT as at } from "../fixtures/personal-observation-input.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
const scope = { members: [{ source_id: "src:pos:v1:orca:local", worktree_id: "worktree-local" },
  { source_id: "src:pos:v1:orca:jm-server", worktree_id: "worktree-jm-server" }] };
const input = () => ({ key: "request-1", observations: { ...observationInput(), portfolios: [] }, capped: false, collections: [{ source_id: "src:pos:v1:orca:local", worktree_id: "worktree-local", state: "completed" as const },
      { source_id: "src:pos:v1:orca:jm-server", worktree_id: "worktree-jm-server", state: "completed" as const }] });

it("records a scoped batch atomically and replays without new observations or receipts", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const store = new ObservationRefreshStore(db, scope);
    const first = store.admit(input(), at);
    expect(first.inserted).toBe(true);
    expect(store.read(first.refresh_id, at)).toMatchObject({ state: "ready", observation_count: 2 });
    const before = db.db.serialize();
    expect(store.admit(input(), at)).toEqual({ ...first, inserted: false });
    expect(db.db.serialize().equals(before)).toBe(true);
    expect(() => store.admit({ ...input(), capped: true }, at)).toThrow("OBSERVATION_REFRESH_INVALID");
    expect(new ObservationRefreshStore(db, { members: scope.members.map(member => ({ ...member, worktree_id: "other" })) }).read(first.refresh_id, at)).toBe(null);
    expect(store.read(first.refresh_id, "2026-08-28T12:05:00.000Z")).toMatchObject({ state: "unavailable", reason: "stale" });
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
it("rolls observations, checkpoints and audit back if receipt insertion fails", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    db.db.exec(`CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON observation_refresh_receipts
      BEGIN SELECT RAISE(ABORT,'receipt failure'); END`);
    const before = db.db.serialize();
    expect(() => new ObservationRefreshStore(db, scope).admit(input(), at)).toThrow("receipt failure");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
it("distinguishes empty, capped and suppressed sources without claiming ready", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const store = new ObservationRefreshStore(db, scope);
    const empty = store.admit({ key: "empty", capped: false, collections: [{ source_id: "src:pos:v1:orca:local", worktree_id: "worktree-local", state: "completed" as const },
      { source_id: "src:pos:v1:orca:jm-server", worktree_id: "worktree-jm-server", state: "completed" as const }], observations: { checked_at: at, orca_tasks: [], portfolios: [] } }, at);
    expect(store.read(empty.refresh_id, at)).toMatchObject({ state: "no_data", observation_count: 0 });
    const capped = store.admit({ ...input(), key: "capped", capped: true }, at);
    expect(store.read(capped.refresh_id, at)).toMatchObject({ state: "unavailable", reason: "capped" });
    const normal = store.admit(input(), at);
    const row = db.db.prepare("SELECT observation_id FROM personal_observations LIMIT 1").get() as { observation_id: string };
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "observation", id: row.observation_id, component_id: "root" }, new Date(at));
    expect(store.read(normal.refresh_id, at)).toMatchObject({ state: "unavailable", reason: "suppressed" });
  } finally { db.close(); }
});
it("rejects a different worktree and excessive admission before any writes", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const before = db.db.serialize();
    expect(() => new ObservationRefreshStore(db, { members: scope.members.map(member => ({ ...member, worktree_id: "other" })) }).admit(input(), at)).toThrow("OBSERVATION_REFRESH_INVALID");
    const large = input(); large.observations.orca_tasks = Array(257).fill(large.observations.orca_tasks[0]);
    expect(() => new ObservationRefreshStore(db, scope).admit(large, at)).toThrow("OBSERVATION_REFRESH_INVALID");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});

it("recovers an old receipt without reviving stale sources and rejects future replay", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const store = new ObservationRefreshStore(db, scope);
    const recordedAt = "2026-08-28T12:00:01.000Z";
    const result = store.admit(input(), recordedAt);
    expect(() => store.admit(input(), at)).toThrow("OBSERVATION_REFRESH_INVALID");
    const before = db.db.serialize();
    expect(store.admit(input(), "2026-08-29T12:00:00.000Z")).toEqual({ ...result, inserted: false });
    expect(store.read(result.refresh_id, "2026-08-29T12:00:00.000Z")).toMatchObject({ state: "unavailable", reason: "stale" });
    expect(db.db.serialize().equals(before)).toBe(true);
    expect(() => db.db.prepare("DELETE FROM observation_refresh_receipts WHERE refresh_id=?").run(result.refresh_id))
      .toThrow("OBSERVATION_REFRESH_IMMUTABLE");
  } finally { db.close(); }
});

it("rejects omitted collection outcomes and records a failed member as unavailable", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const store = new ObservationRefreshStore(db, scope);
    const partial = input(); partial.observations.orca_tasks = partial.observations.orca_tasks.slice(0, 1);
    expect(() => store.admit({ ...partial, collections: partial.collections.slice(0, 1) }, at)).toThrow("OBSERVATION_REFRESH_INVALID");
    expect(db.db.prepare("SELECT COUNT(*) n FROM personal_observations").get()).toEqual({ n: 0 });
    const receipt = store.admit({ ...partial, collections: partial.collections.map((item, index) =>
      ({ ...item, state: index === 0 ? "completed" : "failed" })) }, at);
    expect(store.read(receipt.refresh_id, at)).toMatchObject({ state: "unavailable", reason: "collection_failed" });
  } finally { db.close(); }
});

it("requires exact pair coverage even when source and worktree sets individually match", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    const members = scope.members.flatMap(source => scope.members.map(worktree =>
      ({ source_id: source.source_id, worktree_id: worktree.worktree_id })));
    const store = new ObservationRefreshStore(db, { members });
    const before = db.db.serialize();
    expect(() => store.admit({ key: "missing-pair", capped: false,
      observations: { checked_at: at, orca_tasks: [], portfolios: [] },
      collections: members.slice(0, 3).map(member => ({ ...member, state: "completed" })) }, at)).toThrow("OBSERVATION_REFRESH_INVALID");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
it("fits the maximum declared pair scope into the bounded manifest and rejects larger scope", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate();
    const members = Array.from({ length: 64 }, (_, i) => ({ source_id: `s${i}`.padEnd(256, "a"), worktree_id: `w${i}`.padEnd(256, "b") }));
    const store = new ObservationRefreshStore(db, { members });
    const receipt = store.admit({ key: "maximum", capped: false,
      observations: { checked_at: at, orca_tasks: [], portfolios: [] },
      collections: members.map(member => ({ ...member, state: "completed" })) }, at);
    expect(store.read(receipt.refresh_id, at)).toMatchObject({ state: "no_data" });
    const size = db.db.prepare("SELECT length(CAST(manifest_json AS BLOB)) n FROM observation_refresh_receipts").get() as { n: number };
    expect(size.n).toBeLessThanOrEqual(131072);
    expect(() => new ObservationRefreshStore(db, { members: [...members, { source_id: "extra", worktree_id: "extra" }] }))
      .toThrow("OBSERVATION_REFRESH_INVALID");
  } finally { db.close(); }
});

it("rejects partial and temporally inconsistent timelines without recording a receipt", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  try {
    await db.migrate(); const store = new ObservationRefreshStore(db, scope);
    const before = db.db.serialize();
    const base = input();
    const task = base.observations.orca_tasks[0]!;
    const future = "2026-08-28T12:00:01.000Z";
    const timelines = [
      { ...task.timeline, truncated: true },
      { ...task.timeline, generated_at: future },
      { ...task.timeline, task: { ...task.timeline.task, updated_at: future } },
      { ...task.timeline, events: task.timeline.events.map(event => ({ ...event, created_at: future })) },
    ];
    for (const timeline of timelines) {
      expect(() => store.admit({ ...base, observations: { ...base.observations,
        orca_tasks: [{ ...task, timeline }, ...base.observations.orca_tasks.slice(1)] } }, at))
        .toThrow(/OBSERVATION_REFRESH_INVALID|PERSONAL_CONTRACT_INVALID/);
      expect(db.db.serialize().equals(before)).toBe(true);
    }
    expect(store.read(store.admit(base, at).refresh_id, at)).toMatchObject({ state: "ready" });
  } finally { db.close(); }
});
