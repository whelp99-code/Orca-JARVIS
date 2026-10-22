import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkboardStore } from "../../src/workboard/store.js";
import {
  MAIL_REPLY_GAP_BASE_URL,
  MAIL_REPLY_GAP_BASE_URL_DEFAULT,
  projectMailReplyGaps,
  resolveMailReplyGapBaseUrl,
} from "../../src/workboard/adapters/mail-reply-gap.js";
import { readWorkboard } from "../../src/workboard/projection.js";

function store(): WorkboardStore {
  const db = new Database(":memory:");
  const board = new WorkboardStore(db);
  db.exec(readFileSync(resolve("migrations/101_workboard_attention.sql"), "utf8"));
  return board;
}

const snap = (open: Array<{ id: string; subject: string; receivedAt?: string }>, observedAt: string) => ({
  observedAt,
  baseUrl: MAIL_REPLY_GAP_BASE_URL,
  open: open.map(item => ({ receivedAt: "2026-09-20T01:00:00.000Z", ...item })),
});

describe("mail reply-gap projection", () => {
  it.each(["file:///tmp/mail", "data:text/plain,x", "javascript:alert(1)", "ftp://mail.example", "not a URL"])(
    "rejects an unusable configured URL %s", configured => {
      expect(() => resolveMailReplyGapBaseUrl({ JARVIS_MAIL_REPLY_GAP_BASE_URL: configured }))
        .toThrow("MAIL_REPLY_GAP_LINK_INVALID");
    },
  );

  it("opens an owner-decision task linked to the message and closes it when the gap leaves", () => {
    const board = store();
    const first = projectMailReplyGaps(board, snap([{ id: "41", subject: "견적 부탁드립니다" }], "2026-10-01T00:00:00.000Z"));
    expect(first).toMatchObject({ opened: 1, closed: 0, openIds: ["41"] });
    const view = readWorkboard(board.db, new Date("2026-10-01T00:01:00.000Z"));
    expect(view.works).toHaveLength(1);
    expect(view.works[0]).toMatchObject({ state: "waiting", summary: "회신: 견적 부탁드립니다" });
    expect((view.works[0] as { evidence_ref?: string }).evidence_ref).toBe(`${MAIL_REPLY_GAP_BASE_URL}/#m=41`);
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

  it("defaults the message link to the tailnet Mail Intelligence URL", () => {
    const board = store();
    const linked = projectMailReplyGaps(board, {
      observedAt: "2026-10-01T00:00:00.000Z",
      open: [{ id: "536", subject: "reply", receivedAt: "2026-09-22T07:00:03.000Z" }],
    });
    expect(linked.opened).toBe(1);
    const row = readWorkboard(board.db, new Date("2026-10-01T00:01:00.000Z")).works[0] as { evidence_ref?: string };
    expect(row.evidence_ref).toBe(`${MAIL_REPLY_GAP_BASE_URL}/#m=536`);
    expect(MAIL_REPLY_GAP_BASE_URL).toBe(MAIL_REPLY_GAP_BASE_URL_DEFAULT);
    expect(MAIL_REPLY_GAP_BASE_URL_DEFAULT).toBe("https://jm-omachy.alpines-goldeye.ts.net:8451");
    expect(resolveMailReplyGapBaseUrl({ JARVIS_MAIL_REPLY_GAP_BASE_URL: "https://mail.example:9" }))
      .toBe("https://mail.example:9");
  });

  it("rejects a snapshot whose link origin is not the configured Mail Intelligence origin", () => {
    const board = store();
    const bad = [
      "http://evil.example/#m=1",
      "javascript:alert(1)",
      "data:text/html,hi",
    ];
    for (const baseUrl of bad) {
      expect(() => projectMailReplyGaps(board, {
        observedAt: "2026-10-01T00:00:00.000Z",
        baseUrl,
        open: [{ id: "1", subject: "x", receivedAt: "2026-10-01T00:00:00.000Z" }],
      })).toThrow(/LINK_INVALID/);
    }
    expect(board.works()).toHaveLength(0);
    const sameOrigin = new URL(MAIL_REPLY_GAP_BASE_URL);
    sameOrigin.pathname = "/ignored";
    const accepted = projectMailReplyGaps(board, {
      observedAt: "2026-10-01T00:00:00.000Z",
      baseUrl: sameOrigin.href,
      open: [{ id: "41", subject: "ok", receivedAt: "2026-10-01T00:00:00.000Z" }],
    });
    expect(accepted.opened).toBe(1);
    expect((board.works()[0] as { evidence_ref?: string }).evidence_ref).toBe(`${MAIL_REPLY_GAP_BASE_URL}/#m=41`);
  });

  it("rejects a non-integer message id before ingest", () => {
    const board = store();
    expect(() => projectMailReplyGaps(board, {
      observedAt: "2026-10-01T00:00:00.000Z",
      open: [{ id: "1e2", subject: "x", receivedAt: "2026-10-01T00:00:00.000Z" }],
    })).toThrow(/SNAPSHOT_INVALID/);
    expect(board.works()).toHaveLength(0);
  });
});
