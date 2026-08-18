import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandApprovalReceipt, StoredControlCommand } from "../../src/control-plane.js";
import type { CancelRequest, ReceiptDecisionRequest, RetryRequest } from "../../src/dashboard/contracts.js";
import { DashboardApiError } from "./api.js";
import { createAuthorityMutationClient } from "./authority-api.js";

const CSRF = "c".repeat(32);
const REQUEST_ID = "request-1";
const RECEIPT = {
  schema_version: 1,
  receipt_id: "receipt-1",
  request_id: REQUEST_ID,
  decision: "approve",
  command_digest: `sha256:${"a".repeat(64)}`,
  signer_principal_id: "operator-1",
  authenticated_session_id: "session-1",
  key_id: "key-1",
  algorithm: "Ed25519",
  issued_at: "2026-08-18T12:00:00.000Z",
  not_before: "2026-08-18T12:00:00.000Z",
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: "receipt-nonce-1",
  max_uses: 1,
  status: "issued",
  signature: "private-signature",
} as const satisfies CommandApprovalReceipt;
const COMMAND = {
  schema_version: 1,
  request_id: "request-new",
  action: "workflow.cancel",
  action_level: 3,
  target: { environment: "local", run_id: "run-1" },
  args: { run_id: "run-1" },
  reversible: true,
  requested_by: "jarvis-control-center",
  requested_at: "2026-08-18T12:00:00.000Z",
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: "nonce-new",
  command_digest: `sha256:${"b".repeat(64)}`,
  state: "pending",
} as const satisfies StoredControlCommand;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": "response-1" },
  });
}

function mockFetch(...responses: readonly Response[]): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("authority mutation client", () => {
  it("posts an exact receipt decision with same-origin session CSRF", async () => {
    // Given
    const request = { schema_version: 1, receipt: RECEIPT } as const satisfies ReceiptDecisionRequest;
    const fetchMock = mockFetch(
      jsonResponse({ schema_version: 1, csrf_token: CSRF }),
      jsonResponse({ schema_version: 1, request_id: REQUEST_ID, decision: "approve", state: "approved" }),
    );

    // When
    const result = await createAuthorityMutationClient().decideRequest(REQUEST_ID, request);

    // Then
    expect(result.state).toBe("approved");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/session", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/control/requests/${REQUEST_ID}/decision`,
      expect.objectContaining({
        credentials: "same-origin",
        body: JSON.stringify(request),
        headers: expect.objectContaining({ "X-JARVIS-CSRF": CSRF }),
      }),
    );
  });

  it("posts the exact execute envelope", async () => {
    // Given
    const fetchMock = mockFetch(jsonResponse({
      schema_version: 1,
      execution: { request_id: REQUEST_ID, action: "workflow.start", state: "completed" },
    }));
    const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: CSRF }));

    // When
    await client.executeRequest(REQUEST_ID);

    // Then
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/control/requests/${REQUEST_ID}/execute`,
      expect.objectContaining({ body: JSON.stringify({ schema_version: 1 }) }),
    );
  });

  it("posts the exact cancellation envelope", async () => {
    // Given
    const cancel = {
      schema_version: 1, request_id: "cancel-new", nonce: "cancel-nonce", run_id: "run-1", reason: "stop",
    } as const satisfies CancelRequest;
    const fetchMock = mockFetch(jsonResponse({
      schema_version: 1,
      request: { ...COMMAND, request_id: cancel.request_id },
    }));
    const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: CSRF }));

    // When
    await client.cancelTask("task-1", cancel);

    // Then
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tasks/task-1/cancel",
      expect.objectContaining({ body: JSON.stringify(cancel) }),
    );
  });

  it("posts the exact retry envelope", async () => {
    // Given
    const retry = { schema_version: 1, request_id: "retry-new", nonce: "retry-nonce" } as const satisfies RetryRequest;
    const fetchMock = mockFetch(jsonResponse({
      schema_version: 1,
      request: { ...COMMAND, request_id: retry.request_id },
    }));
    const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: CSRF }));

    // When
    await client.retryRequest(REQUEST_ID, retry);

    // Then
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/control/requests/${REQUEST_ID}/retry`,
      expect.objectContaining({ body: JSON.stringify(retry) }),
    );
  });

  it("rejects an unsafe error envelope without retaining its message", async () => {
    // Given
    mockFetch(jsonResponse({
      schema_version: 1,
      error: { code: "CONTROL_APPROVAL_INVALID", message: "bad private-signature", request_id: "response-1" },
    }, 403));
    const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: CSRF }));

    // When
    const failure = client.executeRequest(REQUEST_ID);

    // Then
    await expect(failure).rejects.toBeInstanceOf(DashboardApiError);
    await expect(failure).rejects.not.toThrow(/private-signature|receipt|token/u);
  });

  it("sanitizes an unsafe injected session failure", async () => {
    // Given
    const client = createAuthorityMutationClient(async () => {
      throw new DashboardApiError({
        kind: "forbidden",
        code: "SESSION_INVALID",
        message: "bad private-signature token",
        request_id: "response-1",
      });
    });

    // When
    const failure = client.executeRequest(REQUEST_ID);

    // Then
    await expect(failure).rejects.toBeInstanceOf(DashboardApiError);
    await expect(failure).rejects.not.toThrow(/private-signature|receipt|token/u);
  });
});
