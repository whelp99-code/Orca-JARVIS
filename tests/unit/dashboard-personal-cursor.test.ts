import { describe, expect, it } from "vitest";
import { PersonalCursorCodec, PersonalCursorError } from "../../src/dashboard/personal-cursor.js";
import { PersonalPagination } from "../../src/dashboard/personal-page.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const KEY = Buffer.alloc(32, 7);
const codec = (sessionId = "session-one") => new PersonalCursorCodec({ key: KEY, sessionId, keyEpoch: 3 });
const values = ["c", "b", "a"].map((id) => ({ key: [`2026-08-30T11:00:0${id === "c" ? 3 : id === "b" ? 2 : 1}.000Z`, id] as const,
  item: { id, label: `row-${id}` } }));

describe("personal dashboard cursor", () => {
  it("encrypts semantic cursor payload and round trips only in its session", () => {
    // Given
    const first = new PersonalPagination(codec()).page({ resource: "daily-runs", values, limit: 2, cursor: null,
      now: NOW, filter: "all", order: "updated_at_desc,id_desc", state: "ready" });
    const token = first.page.next_cursor;
    if (token === null) throw new Error("cursor expected");
    // When
    const visible = Buffer.from(token, "base64url").toString("utf8");
    // Then
    expect(token).not.toContain(".");
    for (const secret of ["daily-runs", "updated_at", "row-b", "session-one"]) expect(visible).not.toContain(secret);
    expect(() => new PersonalPagination(codec("other-session")).page({ resource: "daily-runs", values, limit: 2,
      cursor: token, now: NOW, filter: "all", order: "updated_at_desc,id_desc", state: "ready" })).toThrow(PersonalCursorError);
  });

  it("rejects tamper, truncation, foreign resource, filter, order, budget, and expiry", () => {
    // Given
    const pagination = new PersonalPagination(codec());
    const first = pagination.page({ resource: "daily-runs", values, limit: 2, cursor: null, now: NOW,
      filter: "all", order: "updated_at_desc,id_desc", state: "ready" });
    const token = first.page.next_cursor;
    if (token === null) throw new Error("cursor expected");
    const request = { values, cursor: token, now: NOW, filter: "all", order: "updated_at_desc,id_desc", state: "ready" } as const;
    // When / Then
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 2,
      cursor: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 2, cursor: token.slice(0, -4) })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "source-health", limit: 2 })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 1 })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 2, filter: "other" })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 2, order: "other" })).toThrow(PersonalCursorError);
    expect(() => pagination.page({ ...request, resource: "daily-runs", limit: 2,
      now: new Date(NOW.getTime() + 300_001) })).toThrow(PersonalCursorError);
  });
});
