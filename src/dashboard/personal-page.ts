import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { PersonalCursorError, PersonalCursorStaleError, personalCursorExpiry, type PersonalCursorCodec } from "./personal-cursor.js";
import type { PersonalListResource, PersonalPage, ResourceState } from "./personal-contracts.js";
import { assertSafeIdentifier, sanitizePersonalProjection } from "./personal-privacy.js";

const SNAPSHOT_LIMIT = 32;
const SNAPSHOT_ENTRY_LIMIT = 1_000;
const SNAPSHOT_BYTE_LIMIT = 8 * 1024 * 1024;
type Key = readonly [string, string];
type Keyed = { readonly item: unknown; readonly key: Key; readonly immutable?: unknown };
type FrozenEntry = Keyed & { readonly digest: string };
type Snapshot = {
  readonly id: string;
  readonly resource: PersonalListResource;
  readonly filter: string;
  readonly order: string;
  readonly upper: Key;
  readonly revision: string;
  readonly total: number;
  readonly expiresAt: string;
  readonly entries: readonly FrozenEntry[];
  readonly bytes: number;
};
type PageInput = {
  readonly resource: PersonalListResource;
  readonly values: readonly Keyed[];
  readonly limit: number;
  readonly cursor: string | null;
  readonly now: Date;
  readonly filter: string;
  readonly order: string;
  readonly state: ResourceState;
};

export class PersonalPagination {
  /** Snapshots are mutable bounded session state. */
  private readonly snapshots = new Map<string, Snapshot>();
  private snapshotBytes = 0;

  constructor(private readonly codec: PersonalCursorCodec) {}

  page(input: PageInput): PersonalPage<unknown> {
    assertSafeIdentifier(input.filter);
    assertSafeIdentifier(input.order);
    this.expire(input.now);
    return input.cursor === null ? this.first(input) : this.next(input);
  }

  private first(input: PageInput): PersonalPage<unknown> {
    if (input.values.length > SNAPSHOT_ENTRY_LIMIT) throw new PersonalCursorError();
    const entries = input.values.map(freezeEntry);
    const upper = entries[0]?.key ?? ["", ""];
    const revision = digest(entries.map((entry) => ({ key: entry.key, digest: entry.digest })));
    const expiresAt = personalCursorExpiry(input.now);
    const id = randomUUID();
    const bytes = Buffer.byteLength(canonicalize(entries), "utf8");
    if (bytes > SNAPSHOT_BYTE_LIMIT) throw new PersonalCursorError();
    const snapshot: Snapshot = { id, resource: input.resource, filter: input.filter, order: input.order, upper,
      revision, total: entries.length, expiresAt, entries, bytes };
    const result = this.output(input, snapshot, 0);
    if (result.page.has_more) this.store(snapshot);
    return result;
  }

  private next(input: PageInput): PersonalPage<unknown> {
    const payload = this.codec.decode(input.cursor ?? "", { resource: input.resource, limit: input.limit,
      filter: input.filter, order: input.order, now: input.now });
    const snapshot = this.snapshots.get(payload.snapshot.id);
    if (snapshot === undefined || snapshot.resource !== input.resource || snapshot.filter !== input.filter
      || snapshot.order !== input.order || snapshot.expiresAt !== payload.expires_at
      || snapshot.upper[0] !== payload.snapshot.upper[0] || snapshot.upper[1] !== payload.snapshot.upper[1]
      || snapshot.revision !== payload.snapshot.revision || snapshot.total !== payload.snapshot.total) {
      throw new PersonalCursorStaleError();
    }
    const frozenAnchor = snapshot.entries[payload.anchor.index];
    if (frozenAnchor === undefined || frozenAnchor.key[0] !== payload.anchor.key[0]
      || frozenAnchor.key[1] !== payload.anchor.key[1] || frozenAnchor.digest !== payload.anchor.digest) {
      throw new PersonalCursorStaleError();
    }
    const currentAnchor = input.values.find((entry) => entry.key[0] === payload.anchor.key[0] && entry.key[1] === payload.anchor.key[1]);
    if (currentAnchor === undefined || entryDigest(currentAnchor) !== payload.anchor.digest) throw new PersonalCursorStaleError();
    return this.output(input, snapshot, payload.anchor.index + 1);
  }

  private output(input: PageInput, snapshot: Snapshot, start: number): PersonalPage<unknown> {
    const entries = snapshot.entries.slice(start, start + input.limit);
    const consumed = start + entries.length;
    const hasMore = consumed < snapshot.total;
    const last = entries.at(-1);
    const nextCursor = hasMore && last !== undefined ? this.codec.encode({
      resource: snapshot.resource, limit: input.limit, filter: snapshot.filter, order: snapshot.order,
      expires_at: snapshot.expiresAt,
      snapshot: { id: snapshot.id, upper: snapshot.upper, revision: snapshot.revision, total: snapshot.total },
      anchor: { key: last.key, digest: last.digest, index: consumed - 1 },
    }) : null;
    if (!hasMore) this.remove(snapshot.id);
    return { schema_version: 1, resource: input.resource, generated_at: input.now.toISOString(), state: input.state,
      items: entries.map((entry) => entry.item),
      page: { limit: input.limit, returned: entries.length, total: snapshot.total, has_more: hasMore, next_cursor: nextCursor } };
  }

  private store(snapshot: Snapshot): void {
    while (this.snapshots.size >= SNAPSHOT_LIMIT || this.snapshotBytes + snapshot.bytes > SNAPSHOT_BYTE_LIMIT) {
      const oldest = this.snapshots.keys().next().value;
      if (typeof oldest !== "string") throw new PersonalCursorError();
      this.remove(oldest);
    }
    this.snapshots.set(snapshot.id, snapshot);
    this.snapshotBytes += snapshot.bytes;
  }

  private expire(now: Date): void {
    for (const snapshot of this.snapshots.values()) if (now.toISOString() >= snapshot.expiresAt) this.remove(snapshot.id);
  }

  private remove(id: string): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot === undefined) return;
    this.snapshots.delete(id);
    this.snapshotBytes -= snapshot.bytes;
  }
}

function freezeEntry(value: Keyed): FrozenEntry {
  const key: Key = [assertSafeIdentifier(value.key[0]), assertSafeIdentifier(value.key[1])];
  const item: unknown = JSON.parse(canonicalize(sanitizePersonalProjection(value.item)));
  return { key, item, digest: entryDigest({ ...value, item }) };
}
function entryDigest(value: Keyed): string {
  return digest(value.immutable ?? value.item);
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
