import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { OperationalShell } from "./operational-shell.js";

const NAV_ITEMS = [
  { label: "오늘", href: "/" },
  { label: "워크보드", href: "/workboard" },
  { label: "기억", href: "/memory" },
  { label: "한눈에", href: "/overview" },
  { label: "작업", href: "/tasks" },
  { label: "새 제안", href: "/proposals" },
  { label: "에이전트", href: "/agents" },
  { label: "승인", href: "/approvals" },
  { label: "보안", href: "/security" },
  { label: "조회 준비", href: "/finance-read" },
] as const;

afterEach(cleanup);

function renderShell(connectionState: "connecting" | "live" | "offline", initialPath = "/tasks/task-42"): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <OperationalShell connectionState={connectionState}>
        <h1>Task detail</h1>
        <button type="button">Run control</button>
      </OperationalShell>
    </MemoryRouter>,
  );
}

describe("OperationalShell", () => {
  it("distinguishes initial connection from a failed connection", () => {
    renderShell("connecting");
    const status = screen.getByRole("status", { name: "실시간" });
    expect(status).toHaveTextContent("연결 중");
    expect(status).not.toHaveTextContent("끊김");
  });
  it("provides a visible skip link and focusable main target when content renders", () => {
    renderShell("live");

    const skipLink = screen.getByRole("link", { name: "본문으로 건너뛰기" });
    const main = screen.getByRole("main");

    expect(skipLink).toBeVisible();
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(within(main).getByRole("heading", { name: "Task detail" })).toBeInTheDocument();
  });

  it("exposes exact primary routes and marks the matching route as current", () => {
    renderShell("live");

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    const links = within(navigation).getAllByRole("link");

    expect(links.map((link) => ({
      label: link.textContent,
      href: link.getAttribute("href"),
    }))).toEqual(NAV_ITEMS);
    expect(within(navigation).getByRole("link", { name: "작업" })).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getByRole("link", { name: "한눈에" })).not.toHaveAttribute("aria-current");
  });

  it("announces the connected live-update state", () => {
    renderShell("live");

    const status = screen.getByRole("status", { name: "실시간" });

    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("연결됨");
  });

  it("renders an explicit disconnected service state", () => {
    renderShell("offline");

    const status = screen.getByRole("status", { name: "실시간" });

    expect(status).toHaveTextContent("끊김");
  });

  it("tabs from the skip link through primary navigation in route order", async () => {
    const user = userEvent.setup();
    renderShell("live");

    await user.tab();
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" })).toHaveFocus();
    for (const item of NAV_ITEMS) {
      await user.tab();
      expect(screen.getByRole("link", { name: item.label })).toHaveFocus();
    }
  });
});
