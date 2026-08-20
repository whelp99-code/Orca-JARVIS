import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskDetailEvent } from "../../../src/dashboard/read-model.js";
import { TimelinePanel } from "./timeline-panel.js";

const FIRST_AT = "2026-08-18T09:00:00.000Z";
const SECOND_AT = "2026-08-18T09:01:00.000Z";
const KOREAN_OBJECTIVE = "운영 상태를 안전하게 검증한다";
const KOREAN_EVENT = "배포 증거를 수집했다";
const EVENTS = [
  {
    event_id: "event-1",
    task_id: "task-42",
    source: "workflow",
    kind: "workflow",
    actor: "jarvis-loopgraph",
    title: KOREAN_OBJECTIVE,
    status: "running",
    payload: {},
    evidence_refs: ["evidence://release/42"],
    created_at: FIRST_AT,
    sequence: 1,
  },
  {
    event_id: "event-2",
    task_id: "task-42",
    source: "verification",
    kind: "evidence",
    actor: "jarvis-verifier",
    title: KOREAN_EVENT,
    status: "completed",
    payload: {},
    evidence_refs: ["evidence://release/43"],
    created_at: SECOND_AT,
    sequence: 2,
  },
] as const satisfies readonly TaskDetailEvent[];

const ERROR_STATE = {
  status: "error",
  kind: "server",
  error: {
    kind: "server",
    code: "TIMELINE_UNAVAILABLE",
    message: "Timeline unavailable",
    request_id: "request-timeline",
  },
} as const;

afterEach(cleanup);

describe("TimelinePanel", () => {
  it("renders ordered event evidence in sequence order without changing Korean text", () => {
    // Given
    render(<TimelinePanel state={{ status: "success", data: EVENTS }} />);

    // When
    const region = screen.getByRole("region", { name: "Task timeline" });
    const list = within(region).getByRole("list");
    const items = within(list).getAllByRole("listitem");

    // Then
    expect(list.tagName).toBe("OL");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining(KOREAN_OBJECTIVE),
      expect.stringContaining(KOREAN_EVENT),
    ]);
    expect(screen.getByText(KOREAN_OBJECTIVE)).toBeVisible();
    expect(screen.getByText(KOREAN_EVENT)).toBeVisible();
    expect(screen.getByText("workflow")).toBeVisible();
    expect(screen.getByText("running")).toBeVisible();
    expect(screen.getByText("evidence://release/42")).toBeVisible();
    expect(screen.getByText(FIRST_AT)).toHaveAttribute("datetime", FIRST_AT);
  });

  it("announces the loading variant", () => {
    // Given
    render(<TimelinePanel state={{ status: "loading" }} />);

    // When
    const region = screen.getByRole("region", { name: "Task timeline" });

    // Then
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(within(region).getByRole("status")).toHaveTextContent("Loading timeline");
  });

  it("announces the empty variant", () => {
    // Given
    render(<TimelinePanel state={{ status: "empty", data: [] }} />);

    // When
    const region = screen.getByRole("region", { name: "Task timeline" });

    // Then
    expect(within(region).getByRole("status")).toHaveTextContent("No timeline events");
  });

  it("announces the error variant", () => {
    // Given
    render(<TimelinePanel state={ERROR_STATE} />);

    // When
    const region = screen.getByRole("region", { name: "Task timeline" });

    // Then
    expect(within(region).getByRole("alert")).toHaveTextContent("Timeline unavailable");
  });
});
