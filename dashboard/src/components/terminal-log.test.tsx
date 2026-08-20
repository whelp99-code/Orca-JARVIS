import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../../../src/dashboard/contracts.js";
import type { TerminalLogResponse } from "../../../src/dashboard/terminal-reader.js";
import { TerminalLog } from "./terminal-log.js";

const AGENT_ID = "sha256:terminal-fixture";
const BEARER_SECRET = "Bearer fixture-super-secret-token";
const MAX_LINES = 500;
const SAFE_LINES = Array.from({ length: MAX_LINES }, (_, index) =>
  index === 17 ? `Authorization: ${REDACTED}` : `line-${String(index + 1).padStart(3, "0")}`
);
const LOG_RESPONSE = {
  schema_version: 1,
  agent_id: AGENT_ID,
  status: "running",
  lines: SAFE_LINES,
  truncated: true,
  next_cursor: "cursor-500",
} as const satisfies TerminalLogResponse;
const EMPTY_RESPONSE = {
  schema_version: 1,
  agent_id: AGENT_ID,
  status: "completed",
  lines: [],
  truncated: false,
  next_cursor: null,
} as const satisfies TerminalLogResponse;
const ERROR_STATE = {
  status: "error",
  kind: "server",
  error: {
    kind: "server",
    code: "ORCA_UNAVAILABLE",
    message: "Terminal service unavailable",
    request_id: "request-log",
  },
} as const;

afterEach(cleanup);

describe("TerminalLog", () => {
  it("renders a labeled busy region while logs load", () => {
    // Given
    render(<TerminalLog state={{ status: "loading" }} />);

    // When
    const region = screen.getByRole("region", { name: "Terminal log" });

    // Then
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("Loading terminal log");
  });

  it("announces an explicit empty state", () => {
    // Given
    render(<TerminalLog state={{ status: "empty", data: EMPTY_RESPONSE }} />);

    // When
    const region = screen.getByRole("region", { name: "Terminal log" });

    // Then
    expect(within(region).getByRole("status")).toHaveTextContent("No log output");
    expect(within(region).queryByRole("log")).not.toBeInTheDocument();
  });

  it("announces an error and exposes a keyboard-operable retry", async () => {
    // Given
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<TerminalLog state={ERROR_STATE} onRetry={retry} />);

    // When
    const region = screen.getByRole("region", { name: "Terminal log" });
    await user.click(within(region).getByRole("button", { name: "Retry" }));

    // Then
    expect(within(region).getByRole("alert")).toHaveTextContent("Terminal service unavailable");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("presents at most 500 already-redacted lines in an accessible log", () => {
    // Given
    render(<TerminalLog state={{ status: "success", data: LOG_RESPONSE }} />);

    // When
    const region = screen.getByRole("region", { name: "Terminal log" });
    const log = within(region).getByRole("log", { name: "Terminal output" });
    const renderedLines = (log.textContent ?? "").split("\n");

    // Then
    expect(renderedLines).toHaveLength(MAX_LINES);
    expect(log).toHaveTextContent(REDACTED);
    expect(log).not.toHaveTextContent(BEARER_SECRET);
    expect(within(region).getByText("Earlier lines omitted")).toBeVisible();
  });
});
