import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { OperationalShell } from "./operational-shell.js";

const NAV_ITEMS = [
  { label: "Overview", href: "/" },
  { label: "Tasks", href: "/tasks" },
  { label: "New proposal", href: "/proposals" },
  { label: "Agents", href: "/agents" },
  { label: "Approvals", href: "/approvals" },
] as const;

afterEach(cleanup);

function renderShell(connectionState: "live" | "offline", initialPath = "/tasks/task-42"): void {
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
  it("provides a visible skip link and focusable main target when content renders", () => {
    // Given
    renderShell("live");

    // When
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");

    // Then
    expect(skipLink).toBeVisible();
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(within(main).getByRole("heading", { name: "Task detail" })).toBeInTheDocument();
  });

  it("exposes exact primary routes and marks the matching route as current", () => {
    // Given
    renderShell("live");

    // When
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    const links = within(navigation).getAllByRole("link");

    // Then
    expect(links.map((link) => ({
      label: link.textContent,
      href: link.getAttribute("href"),
    }))).toEqual(NAV_ITEMS);
    expect(within(navigation).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("announces the connected live-update state", () => {
    // Given
    renderShell("live");

    // When
    const status = screen.getByRole("status", { name: "Live updates" });

    // Then
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Connected");
  });

  it("renders an explicit disconnected service state", () => {
    // Given
    renderShell("offline");

    // When
    const status = screen.getByRole("status", { name: "Live updates" });

    // Then
    expect(status).toHaveTextContent("Disconnected");
  });

  it("tabs from the skip link through primary navigation in route order", async () => {
    // Given
    const user = userEvent.setup();
    renderShell("live");

    // When / Then
    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveFocus();
    for (const item of NAV_ITEMS) {
      await user.tab();
      expect(screen.getByRole("link", { name: item.label })).toHaveFocus();
    }
  });
});
