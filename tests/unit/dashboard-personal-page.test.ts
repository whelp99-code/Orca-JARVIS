import { describe, expect, it } from "vitest";
import { PersonalCursorCodec, PersonalCursorStaleError } from "../../src/dashboard/personal-cursor.js";
import type { PersonalListResource } from "../../src/dashboard/personal-contracts.js";
import { PersonalPagination } from "../../src/dashboard/personal-page.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const resources: readonly PersonalListResource[] = ["daily-runs", "decision-inbox", "notification-intents", "source-health"];
const values = ["d", "c", "b", "a"].map((id, index) => ({
  key: [`2026-08-30T11:00:0${4 - index}.000Z`, id] as const,
  item: { id, immutable: `digest-${id}` },
}));
const create = () => new PersonalPagination(new PersonalCursorCodec({ key: Buffer.alloc(32, 9), sessionId: "session", keyEpoch: 1 }));

describe("personal snapshot pagination", () => {
  it.each(resources)("freezes total and membership across insertion for %s", (resource) => {
    // Given
    const pagination = create();
    const first = pagination.page({ resource, values, limit: 2, cursor: null, now: NOW,
      filter: "all", order: "descending", state: "ready" });
    const cursor = first.page.next_cursor;
    if (cursor === null) throw new Error("cursor expected");
    const inserted = [...values, { key: ["2026-08-30T10:00:00.000Z", "inserted"] as const,
      item: { id: "inserted", immutable: "digest-inserted" } }];
    // When
    const second = pagination.page({ resource, values: inserted, limit: 2, cursor, now: NOW,
      filter: "all", order: "descending", state: "ready" });
    // Then
    expect(first.page.total).toBe(4);
    expect(second.page.total).toBe(4);
    expect([...first.items, ...second.items].map(itemId)).toEqual(["d", "c", "b", "a"]);
    expect(second.page.has_more).toBe(false);
  });

  it("keeps future snapshot item bytes stable after a live update", () => {
    // Given
    const pagination = create();
    const first = pagination.page({ resource: "notification-intents", values, limit: 2, cursor: null, now: NOW,
      filter: "all", order: "descending", state: "ready" });
    const cursor = first.page.next_cursor;
    if (cursor === null) throw new Error("cursor expected");
    const updated = values.map((value) => value.item.id === "a"
      ? { ...value, item: { ...value.item, immutable: "live-update" } } : value);
    // When
    const second = pagination.page({ resource: "notification-intents", values: updated, limit: 2, cursor, now: NOW,
      filter: "all", order: "descending", state: "ready" });
    // Then
    expect(second.items.map(itemImmutable)).toEqual(["digest-b", "digest-a"]);
    expect(second.page.total).toBe(4);
  });

  it("returns an exact stale cursor when the anchor is deleted or changed", () => {
    // Given
    const pagination = create();
    const first = pagination.page({ resource: "daily-runs", values, limit: 2, cursor: null, now: NOW,
      filter: "all", order: "descending", state: "ready" });
    const cursor = first.page.next_cursor;
    if (cursor === null) throw new Error("cursor expected");
    // When / Then
    expect(() => pagination.page({ resource: "daily-runs", values: values.filter((value) => value.item.id !== "c"), limit: 2,
      cursor, now: NOW, filter: "all", order: "descending", state: "ready" })).toThrow(PersonalCursorStaleError);
    const changed = values.map((value) => value.item.id === "c" ? { ...value, item: { ...value.item, immutable: "changed" } } : value);
    expect(() => pagination.page({ resource: "daily-runs", values: changed, limit: 2, cursor, now: NOW,
      filter: "all", order: "descending", state: "ready" })).toThrow(PersonalCursorStaleError);
  });
});

function itemId(value: unknown): unknown {
  return typeof value === "object" && value !== null && "id" in value ? value.id : undefined;
}
function itemImmutable(value: unknown): unknown {
  return typeof value === "object" && value !== null && "immutable" in value ? value.immutable : undefined;
}
