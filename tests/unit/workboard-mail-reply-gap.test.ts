import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkboardStore } from "../../src/workboard/store.js";
import { projectMailReplyGaps } from "../../src/workboard/adapters/mail-reply-gap.js";
import { readWorkboard } from "../../src/workboard/projection.js";

function store(): WorkboardStore {
  const db = new Database(":memory:");
  const board = new WorkboardStore(db);
  db.exec(readFileSync(resolve("migrations/101_workboard_attention.sql"), "utf8"));
  return board;
}

const snap = (open: Array<{ id: string; subject: string; receivedAt?: string }>, observedAt: string) => ({
  observedAt,
  baseUrl: "http://127.0.0.1:3010",
  open: open.map(item => ({ receivedAt: "2026-09-20T01:00:00.000Z", ...item })),
});

describe("mail reply-gap projection", () => {
  it("opens an owner-decision task linked to the message and closes it when the gap leaves", () => {
    const board = store();
    const first = projectMailReplyGaps(board, snap([{ id: "41", subject: "견적 부탁드립니다" }], "2026-10-01T00:00:00.000Z"));
    expect(first).toMatchObject({ opened: 1, closed: 0, openIds: ["41"] });
    const view = readWorkboard(board.db, new Date("2026-10-01T00:01:00.000Z"));
    expect(view.works).toHaveLength(1);
    expect(view.works[0]).toMatchObject({ state: "waiting", summary: "회신: 견적 부탁드립니다" });
    expect((view.works[0] as { evidence_ref?: string }).evidence_ref).toBe("http://127.0.0.1:3010/#m=41");
    expect(view.attention.map(item => item.workId)).toEqual([view.works[0]?.work_id]);
    expect(view.attention[0]).toMatchObject({ rank: 0, reasons: ["user_decision"] });

    const second = projectMailReplyGaps(board, snap([], "2026-10-01T00:15:00.000Z"));
    expect(second.closed).toBe(1);
    const after = readWorkboard(board.db, new Date("2026-10-01T00:16:00.000Z"));
    expect(after.works).toHaveLength(0);
    expect(after.attention).toHaveLength(0);
    const ledger = board.db.prepare("SELECT COUNT(*) AS n FROM workboard_events").get() as { n: number };
    expect(ledger.n).toBe(2);
  });

  it("rejects a snapshot that would hide the mail link", () => {
    const board = store();
    expect(() => projectMailReplyGaps(board, {
      observedAt: "2026-10-01T00:00:00.000Z",
      baseUrl: "file:///tmp",
      open: [{ id: "1", subject: "x", receivedAt: "2026-10-01T00:00:00.000Z" }],
    })).toThrow(/LINK_INVALID/);
  });
});
