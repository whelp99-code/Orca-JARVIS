import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandApprovalReceipt, StoredControlCommand } from "../../src/control-plane.js";
import type { ReceiptDecisionRequest, RetryRequest } from "../../src/dashboard/contracts.js";
import type { DashboardDecision, DashboardExecution } from "../../src/dashboard/authority-service.js";
import type { OverviewApproval } from "../../src/dashboard/read-model.js";
import { DashboardApiError } from "./api.js";
import { AuthorityControls } from "./authority-controls.js";

type AuthorityMutationClient = Readonly<{
  decideRequest: (requestId: string, request: ReceiptDecisionRequest) => Promise<DashboardDecision>;
  executeRequest: (requestId: string) => Promise<DashboardExecution>;
  retryRequest: (sourceRequestId: string, request: RetryRequest) => Promise<StoredControlCommand>;
}>;
type GeneratedIdKind = "request_id" | "nonce";
type IdFactory = (kind: GeneratedIdKind) => string;

const AT = "2026-08-18T12:00:00.000Z";
const PRIVATE_SIGNATURE = "private-signature-must-not-render";
const IDS = {
  request_id: "req-retry-deterministic",
  nonce: "nonce-retry-deterministic",
} as const satisfies Record<GeneratedIdKind, string>;
const BASE_REQUEST = {
  request_id: "req-authority-1",
  action: "workflow.start",
  action_level: 2,
  requested_at: AT,
  requested_by: "jarvis-control-center",
  summary: "Start a bounded workflow",
  state: "pending",
} as const satisfies OverviewApproval;
const SIGNED_RECEIPT = {
  schema_version: 1,
  receipt_id: "receipt-authority-1",
  request_id: BASE_REQUEST.request_id,
  decision: "approve",
  command_digest: `sha256:${"a".repeat(64)}`,
  signer_principal_id: "operator-1",
  authenticated_session_id: "action-hub-session",
  key_id: "decision-key-1",
  algorithm: "Ed25519",
  issued_at: AT,
  not_before: AT,
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: "receipt-nonce-1",
  max_uses: 1,
  status: "issued",
  signature: PRIVATE_SIGNATURE,
} as const satisfies CommandApprovalReceipt;
const RETRIED = {
  schema_version: 1,
  request_id: IDS.request_id,
  action: BASE_REQUEST.action,
  action_level: BASE_REQUEST.action_level,
  target: { environment: "local", run_id: "run-authority-1" },
  args: { run_id: "run-authority-1" },
  reversible: true,
  requested_by: "jarvis-control-center",
  requested_at: AT,
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: IDS.nonce,
  command_digest: `sha256:${"b".repeat(64)}`,
  state: "pending",
} as const satisfies StoredControlCommand;

function requestIn(state: string): OverviewApproval {
  return { ...BASE_REQUEST, state };
}

function createClient() {
  const decideRequest = vi.fn<AuthorityMutationClient["decideRequest"]>();
  const executeRequest = vi.fn<AuthorityMutationClient["executeRequest"]>();
  const retryRequest = vi.fn<AuthorityMutationClient["retryRequest"]>();
  const client = { decideRequest, executeRequest, retryRequest } satisfies AuthorityMutationClient;
  return { client, decideRequest, executeRequest, retryRequest };
}

function renderControls(request: OverviewApproval, client: AuthorityMutationClient, enabled = true) {
  const idFactory = vi.fn<IdFactory>((kind) => IDS[kind]);
  render(<AuthorityControls request={request} client={client} idFactory={idFactory} enabled={enabled} />);
  return { user: userEvent.setup(), idFactory };
}

afterEach(cleanup);

describe("receipt-bound authority controls", () => {
  it.each(["pending", "approved", "failed"])("routes %s task execution from general approval screens to its reviewed detail", (state) => {
    const current = createClient();
    render(<MemoryRouter><AuthorityControls request={{ ...BASE_REQUEST, action: "task.execute", state, task_id: "task/a" }}
      client={current.client} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "작업 실행 상세 열기" })).toHaveAttribute("href", "/tasks/task%2Fa");
    expect(screen.queryByRole("button", { name: "Execute approved request" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Signed receipt JSON")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
    expect(current.executeRequest).not.toHaveBeenCalled(); expect(current.decideRequest).not.toHaveBeenCalled();
  });

  it("shows pending request evidence and accessible receipt controls", () => {
    // Given / When
    const current = createClient();
    renderControls(BASE_REQUEST, current.client);

    // Then
    expect(screen.getByText(BASE_REQUEST.action)).toBeInTheDocument();
    expect(screen.getByText("Level 2")).toBeInTheDocument();
    expect(screen.getByText(BASE_REQUEST.request_id)).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Signed receipt JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit signed receipt" })).toBeEnabled();
  });

  it("disables every receipt input when the canonical resource is stale", async () => {
    // Given / When: cached authority evidence is rendered without live authority.
    const current = createClient();
    const { user } = renderControls(BASE_REQUEST, current.client, false);

    // Then: neither keyboard nor pointer submission can cross the mutation seam.
    expect(screen.getByRole("textbox", { name: "Signed receipt JSON" })).toBeDisabled();
    const submit = screen.getByRole("button", { name: "Submit signed receipt" });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(current.decideRequest).not.toHaveBeenCalled();
  });

  it.each([
    { decision: "approve", state: "approved" },
    { decision: "reject", state: "rejected" },
  ] as const)("submits an intact $decision receipt and announces $state", async ({ decision, state }) => {
    // Given
    const receipt = {
      ...SIGNED_RECEIPT,
      receipt_id: `receipt-${decision}`,
      decision,
      signature: `${PRIVATE_SIGNATURE}-${decision}`,
    } satisfies CommandApprovalReceipt;
    const receiptJson = JSON.stringify(receipt, null, 2);
    const current = createClient();
    current.decideRequest.mockResolvedValue({
      schema_version: 1,
      request_id: BASE_REQUEST.request_id,
      decision,
      state,
    });
    const { user } = renderControls(BASE_REQUEST, current.client);
    const textarea = screen.getByRole("textbox", { name: "Signed receipt JSON" });
    await user.click(textarea);
    await user.paste(receiptJson);

    // When
    await user.click(screen.getByRole("button", { name: "Submit signed receipt" }));

    // Then
    expect(current.decideRequest).toHaveBeenCalledOnce();
    expect(current.decideRequest).toHaveBeenCalledWith(
      BASE_REQUEST.request_id,
      { schema_version: 1, receipt },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(`Request ${state}`);
    expect(screen.queryByDisplayValue(receiptJson)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(receipt.signature);
  });

  it("reports malformed receipt JSON locally and preserves it for correction", async () => {
    // Given
    const malformed = `{"signature":"${PRIVATE_SIGNATURE}"`;
    const current = createClient();
    const { user } = renderControls(BASE_REQUEST, current.client);
    const textarea = screen.getByRole("textbox", { name: "Signed receipt JSON" });
    await user.click(textarea);
    await user.paste(malformed);

    // When
    await user.click(screen.getByRole("button", { name: "Submit signed receipt" }));

    // Then
    expect(screen.getByRole("alert")).toHaveTextContent("Signed receipt must be valid JSON");
    expect(textarea).toHaveValue(malformed);
    expect(current.decideRequest).not.toHaveBeenCalled();
    expect(current.executeRequest).not.toHaveBeenCalled();
    expect(current.retryRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["transport", new TypeError(`Failed to fetch ${PRIVATE_SIGNATURE}`)],
    ["API", new DashboardApiError({
      kind: "forbidden",
      code: "CONTROL_APPROVAL_INVALID",
      message: `Invalid receipt ${PRIVATE_SIGNATURE}`,
      request_id: "api-request-1",
    })],
  ] as const)("renders a safe retryable error for a %s failure", async (_kind, error) => {
    // Given
    const receiptJson = JSON.stringify(SIGNED_RECEIPT);
    const current = createClient();
    current.decideRequest.mockRejectedValue(error);
    const { user } = renderControls(BASE_REQUEST, current.client);
    const textarea = screen.getByRole("textbox", { name: "Signed receipt JSON" });
    await user.click(textarea);
    await user.paste(receiptJson);

    // When
    await user.click(screen.getByRole("button", { name: "Submit signed receipt" }));

    // Then
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to submit signed receipt");
    expect(alert).not.toHaveTextContent(SIGNED_RECEIPT.receipt_id);
    expect(alert).not.toHaveTextContent(PRIVATE_SIGNATURE);
    expect(textarea).toHaveValue(receiptJson);
    expect(screen.getByRole("button", { name: "Submit signed receipt" })).toBeEnabled();
    expect(current.decideRequest).toHaveBeenCalledOnce();
  });

  it.each([
    ["completed", "status"],
    ["failed", "alert"],
  ] as const)("executes an approved request and announces %s", async (state, role) => {
    // Given
    const current = createClient();
    current.executeRequest.mockResolvedValue({
      schema_version: 1,
      execution: {
        request_id: BASE_REQUEST.request_id,
        action: BASE_REQUEST.action,
        state,
        ...(state === "failed" ? { failure_code: "APPROVED_COMMAND_FAILED" } : {}),
      },
    });
    const { user } = renderControls(requestIn("approved"), current.client);

    // When
    await user.click(screen.getByRole("button", { name: "Execute approved request" }));

    // Then
    expect(current.executeRequest).toHaveBeenCalledOnce();
    expect(current.executeRequest).toHaveBeenCalledWith(BASE_REQUEST.request_id);
    expect(await screen.findByRole(role)).toHaveTextContent(`Execution ${state}`);
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
  });

  it.each(["pending", "rejected"])("does not execute a %s request", (state) => {
    // Given / When
    const current = createClient();
    renderControls(requestIn(state), current.client);

    // Then
    expect(screen.queryByRole("button", { name: "Execute approved request" })).not.toBeInTheDocument();
    expect(current.executeRequest).not.toHaveBeenCalled();
  });

  it("retries a failed executable request with deterministic identifiers", async () => {
    // Given
    const current = createClient();
    current.retryRequest.mockResolvedValue(RETRIED);
    const { user, idFactory } = renderControls(requestIn("failed"), current.client);

    // When
    await user.click(screen.getByRole("button", { name: "Retry failed request" }));

    // Then
    expect(current.retryRequest).toHaveBeenCalledWith(BASE_REQUEST.request_id, {
      schema_version: 1,
      request_id: IDS.request_id,
      nonce: IDS.nonce,
    });
    expect(idFactory.mock.calls.map(([kind]) => kind)).toEqual(["request_id", "nonce"]);
    const pending = await screen.findByRole("region", { name: "Pending request" });
    expect(pending).toHaveTextContent(IDS.request_id);
    expect(pending).toHaveTextContent(BASE_REQUEST.action);
    expect(pending).toHaveTextContent("Level 2");
    expect(pending).toHaveTextContent("pending");
  });

  it("guides an expired workflow to a new proposal without calling retry", () => {
    const current = createClient();
    renderControls({ ...requestIn("failed"), retry_status: "replan_required" }, current.client);
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "새 작업 제안" })).toHaveAttribute("href", "/proposals");
    expect(screen.getByRole("status")).toHaveTextContent("새 승인을 받아주세요");
    expect(current.retryRequest).not.toHaveBeenCalled();
  });

  it("removes retry when the server finds expiry after the displayed eligibility", async () => {
    const current = createClient();
    current.retryRequest.mockRejectedValue(new DashboardApiError({ kind: "server",
      code: "RETRY_REPLAN_REQUIRED", message: "private response must not render", request_id: "api-request" }));
    const { user } = renderControls({ ...requestIn("failed"), retry_status: "allowed" }, current.client);
    await user.click(screen.getByRole("button", { name: "Retry failed request" }));
    expect(await screen.findByRole("link", { name: "새 작업 제안" })).toHaveAttribute("href", "/proposals");
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private response must not render");
    expect(current.retryRequest).toHaveBeenCalledOnce();
  });

  it("hides retry for a nonexecutable failed command", () => {
    const current = createClient();
    renderControls({ ...requestIn("failed"), retry_status: "not_allowed" }, current.client);
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
  });

  it.each(["pending", "approved", "rejected", "completed"])("does not retry a %s request", (state) => {
    // Given / When
    const current = createClient();
    renderControls(requestIn(state), current.client);

    // Then
    expect(screen.queryByRole("button", { name: "Retry failed request" })).not.toBeInTheDocument();
    expect(current.retryRequest).not.toHaveBeenCalled();
  });
});
