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
