import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TaskGraph } from "./task-graph.js";

const SOURCE_IDS = ["request:002", "run:001", "evidence:003"] as const;

afterEach(cleanup);

describe("TaskGraph", () => {
  it("renders generic start and edge labels in canonical source-id order", () => {
    // Given
    render(<TaskGraph sourceIds={SOURCE_IDS} />);

    // When
    const region = screen.getByRole("region", { name: "Task graph" });
    const graph = within(region).getByRole("img", { name: "Task source graph" });
    const graphText = graph.textContent ?? "";

    // Then
    expect(within(region).getByRole("button", { name: "Graph view" })).toHaveAttribute("aria-pressed", "true");
    expect(within(region).getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "false");
    expect(within(graph).getAllByText("Start")).toHaveLength(1);
    expect(within(graph).getAllByText("Edge")).toHaveLength(SOURCE_IDS.length - 1);
    expect(graphText.indexOf(SOURCE_IDS[0])).toBeGreaterThanOrEqual(0);
    expect(graphText.indexOf(SOURCE_IDS[0])).toBeLessThan(graphText.indexOf(SOURCE_IDS[1]));
    expect(graphText.indexOf(SOURCE_IDS[1])).toBeLessThan(graphText.indexOf(SOURCE_IDS[2]));
  });

  it("switches to an equivalent semantic list with selected view state", async () => {
    // Given
    const user = userEvent.setup();
    render(<TaskGraph sourceIds={SOURCE_IDS} />);
    const graphView = screen.getByRole("button", { name: "Graph view" });
    const listView = screen.getByRole("button", { name: "List view" });

    // When
    await user.click(listView);

    // Then
    expect(graphView).toHaveAttribute("aria-pressed", "false");
    expect(listView).toHaveAttribute("aria-pressed", "true");
    const list = screen.getByRole("list", { name: "Task sources" });
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      SOURCE_IDS.map((sourceId) => expect.stringContaining(sourceId)),
    );
  });

  it("operates the Graph and List controls from the keyboard", async () => {
    // Given
    const user = userEvent.setup();
    render(<TaskGraph sourceIds={SOURCE_IDS} />);
    const graphView = screen.getByRole("button", { name: "Graph view" });
    const listView = screen.getByRole("button", { name: "List view" });

    // When
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");

    // Then
    expect(graphView).not.toHaveFocus();
    expect(listView).toHaveFocus();
    expect(listView).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("list", { name: "Task sources" })).toBeInTheDocument();
  });

  it("announces an explicit empty state when no source IDs exist", () => {
    // Given
    render(<TaskGraph sourceIds={[]} />);

    // When
    const region = screen.getByRole("region", { name: "Task graph" });

    // Then
    expect(within(region).getByRole("status")).toHaveTextContent("No task sources");
  });
});
