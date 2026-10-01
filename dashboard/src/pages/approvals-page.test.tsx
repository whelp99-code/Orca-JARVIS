import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlRequestListResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityMutationClient } from "../authority-api.js";
import { ApprovalsPage } from "./approvals-page.js";

const AT = "2026-08-18T00:00:00.000Z";
const REQUEST = {
  request_id: "request-approval-1",
  action: "workflow.start",
  action_level: 2,
  requested_at: AT,
  requested_by: "jarvis-control-center",
  summary: "Start workflow",
  state: "pending",
} as const;
const populated = {
  schema_version: 1,
  items: [REQUEST],
} as const satisfies ControlRequestListResponse;
const retryableError = {
  status: "error",
  kind: "server",
  error: {
    kind: "server",
    code: "ORCA_UNAVAILABLE",
    message: "Approvals unavailable",
    request_id: "req-approvals",
  },
} as const;

function createClient(): Pick<AuthorityMutationClient, "decideRequest" | "executeRequest" | "retryRequest"> {
  return {
    decideRequest: vi.fn(),
    executeRequest: vi.fn(),
    retryRequest: vi.fn(),
  };
}

afterEach(cleanup);

describe("ApprovalsPage", () => {
  it("keeps receipt-bound authority controls on a populated success state", () => {
    // Given / When
    render(<ApprovalsPage state={{ status: "success", data: populated }} client={createClient()} />);

    // Then
    expect(screen.getByText(REQUEST.request_id)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "서명 영수증" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "서명 제출" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });

  it("places the control-request pager inside admin tools, not beside the owner inbox", () => {
    const data = {
      schema_version: 1,
      items: [],
      page: { limit: 50, total: 4, returned: 0, has_more: false, next_cursor: null },
    } as const satisfies ControlRequestListResponse;
    const { container } = render(
      <ApprovalsPage state={{ status: "empty", data }} client={createClient()} onFirst={() => undefined} onNext={() => undefined} />,
    );
    const frame = container.querySelector("section.page-frame");
    const tools = frame?.querySelector(":scope > details.admin-tools");
    const pager = container.querySelector("nav.record-meta");
    const inbox = frame?.querySelector(":scope > section.panel");
    expect(inbox).not.toBeNull();
    expect(tools).not.toBeNull();
    expect(pager).not.toBeNull();
    expect(frame?.querySelector(":scope > nav")).toBeNull();
    if (tools === null || tools === undefined || pager === null || inbox === null || inbox === undefined) {
      throw new Error("approvals layout nodes missing");
    }
    expect(tools.contains(pager)).toBe(true);
    expect(inbox.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(tools.querySelector("summary")?.textContent).toBe("관리자 도구");
  });

  it("invokes onRetry once from a keyboard-operable Retry control", async () => {
    // Given
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ApprovalsPage state={retryableError} client={createClient()} onRetry={onRetry} />);

    // When
    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    // Then
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
