import "@testing-library/jest-dom/vitest";
import Database from "better-sqlite3";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkboardResponse, type WorkboardResponse } from "../../../src/dashboard/workboard-routes.js";
import {
  openWorkboardFixture,
  WORKBOARD_FIXTURE_NOW as NOW,
  WORKBOARD_IDS as IDS,
  WORKBOARD_SOURCE as SOURCE,
  WORKBOARD_SOURCE_KEY as SOURCE_KEY,
  WORKBOARD_TEXT as T,
} from "../../../tests/fixtures/workboard-fixture.js";
import { HANDLE_AT_SOURCE, UNKNOWN_PURPOSE, WorkboardPage, WorkboardRoute } from "./page.js";

function projectFixture(): WorkboardResponse {
  const db = openWorkboardFixture();
  try {
    // The route is read-only by contract; SQLite rejects any write attempt while query_only is on.
    db.pragma("query_only = ON");
    return readWorkboardResponse(db, NOW);
  } finally {
    db.close();
  }
}

afterEach(cleanup);

describe("workboard projection route", () => {
  it("reports an uncollected board when the workboard tables are absent", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("query_only = ON");
      const data = readWorkboardResponse(db, NOW);
      expect(data).toMatchObject({ schema_version: 1, generated_at: NOW.toISOString(), collected: false, attention: [], groups: [] });
      expect(data.sources).toHaveLength(20);
      expect(data.sources.every(source => source.current_work_total === null && source.reason !== null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("shows a source with no work row and its coverage reason without calling it zero work", () => {
    const db = openWorkboardFixture();
    const id = "mac:codex-desktop:local";
    const reason = "application present; no bounded session enumeration supported";
    try {
      db.prepare("INSERT INTO workboard_sources(source_key,coverage,warning) VALUES(?,?,?)")
        .run(`${id}:initial`, "unknown", reason);
      db.pragma("query_only = ON");
      const data = readWorkboardResponse(db, NOW);
      expect(data.sources).toContainEqual(expect.objectContaining({ id, classification: "unknown_current_work_coverage", reason, current_work_total: null }));
      expect(data.sources.filter(source => source.classification === "unknown_current_work_coverage")).toHaveLength(21);
      const { container } = render(<WorkboardPage data={data} now={() => NOW} />);
      const section = screen.getByRole("region", { name: "관측 범위를 확인하지 못한 곳" });
      expect(section).toHaveTextContent("Mac Codex 데스크톱");
      expect(section).toHaveTextContent(reason);
      expect(section).not.toHaveTextContent("0건");
      expect(container.innerHTML).not.toContain(id);
    } finally {
      db.close();
    }
  });

  it("queues items needing the user first and groups every work by project purpose", () => {
    const data = projectFixture();
    expect(data.collected).toBe(true);
    expect(data.attention.map((card) => [card.rank, card.summary])).toEqual([[0, T.whatA], [1, T.whatC], [3, T.whatD]]);
    expect(data.groups.map((group) => [group.project_id, group.purpose, group.status, group.works.length])).toEqual([
      ["orca-jarvis", T.purposeJarvis, "confirmed", 2],
      [null, null, "unknown", 1],
      ["second-brain", T.purposeBrain, "proposed", 1],
    ]);
    const decision = data.attention[0];
    expect(decision?.purpose).toEqual({ project_id: "orca-jarvis", text: T.purposeJarvis, status: "confirmed", why: T.whyA, needs_reconfirmation: false });
    expect(decision?.source).toEqual({ host: SOURCE.host, app: SOURCE.app, scope: SOURCE.scope });
    expect(decision?.evidence.map((item) => item.value)).toEqual(expect.arrayContaining([IDS.digestA, IDS.sessionA, SOURCE_KEY, SOURCE.generation]));
  });
});

describe("WorkboardPage", () => {
  it("keeps digests, session ids, and PIDs out of the default render", () => {
    const { container } = render(<WorkboardPage data={projectFixture()} now={() => NOW} />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/sha256:/u);
    expect(html).not.toMatch(/term_/u);
    expect(html).not.toMatch(/\bPID\b/u);
  });

  it("leads with why, names unknown purposes exactly, and routes unsupported actions to the source", () => {
    render(<WorkboardPage data={projectFixture()} now={() => NOW} />);
    const lead = screen.getByRole("region", { name: "지금 당신이 필요한 일" });
    const queue = within(lead).getAllByRole("listitem");
    expect(queue).toHaveLength(3);
    expect(queue[0]).toHaveTextContent("결정 필요");
    expect(queue[0]).toHaveTextContent(T.whyA);
    expect(queue[0]).toHaveTextContent(T.whatA);
    expect(queue[0]).toHaveTextContent(`결정이 필요합니다: ${T.decisionA}`);
    expect(queue[0]).toHaveTextContent(HANDLE_AT_SOURCE);
    expect(queue[0]).toHaveTextContent("orca-jarvis/purpose-workboard @ jm-workstation");
    expect(queue[0]).toHaveTextContent("마감 45분 남음");
    expect(queue[1]).toHaveTextContent(UNKNOWN_PURPOSE);
    expect(queue[1]).toHaveTextContent(T.whatC);
    const groups = within(screen.getByRole("region", { name: "목적별 진행 상황" })).getAllByRole("region");
    expect(groups.map((group) => within(group).getByRole("heading", { level: 2 }).textContent)).toEqual([T.purposeJarvis, UNKNOWN_PURPOSE, T.purposeBrain]);
    expect(groups[0]).toHaveTextContent(T.whyB);
    expect(groups[0]).toHaveTextContent("목적 제안됨");
    expect(screen.queryByRole("button", { name: /결정|다시 시작|막힘 풀기|검증 완료/u })).toBeNull();
  });

  it("reveals evidence only through the 근거 보기 disclosure", async () => {
    const user = userEvent.setup();
    const { container } = render(<WorkboardPage data={projectFixture()} now={() => NOW} />);
    const toggle = screen.getAllByRole("button", { name: "근거 보기" })[0];
    expect(toggle).toBeDefined();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle!);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("근거 닫기");
    const panel = document.getElementById(toggle!.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent(IDS.digestA);
    expect(panel).toHaveTextContent(IDS.sessionA);
    expect(panel).toHaveTextContent(SOURCE.generation);
    expect(container.innerHTML).toMatch(/sha256:/u);
    await user.click(toggle!);
    expect(container.innerHTML).not.toMatch(/sha256:/u);
  });
});

describe("WorkboardRoute", () => {
  it("loads through the client and renders the board", async () => {
    const data = projectFixture();
    render(<WorkboardRoute load={async () => data} now={() => NOW} />);
    // The loading state has its own h1; the lead region exists only once the response has rendered.
    const lead = await screen.findByRole("region", { name: "지금 당신이 필요한 일" });
    expect(lead).toHaveTextContent(T.whyA);
    expect(screen.getByRole("heading", { level: 1, name: "워크보드" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로 고침" })).toBeInTheDocument();
  });

  it("names the reload effect when loading fails", async () => {
    render(<WorkboardRoute load={async () => { throw new Error("offline"); }} now={() => NOW} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("워크보드를 불러오지 못했습니다");
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeInTheDocument();
  });
});
