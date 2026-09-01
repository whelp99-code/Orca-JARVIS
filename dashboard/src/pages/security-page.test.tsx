import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPage, type SecurityClient } from "./security-page.js";

afterEach(cleanup);

function client(): SecurityClient {
  return {
    listCredentials: vi.fn(async () => ({ items: [] })),
    beginEnrollment: vi.fn(async () => ({ enrollment_id: "enroll-1" })),
    loadRequest: vi.fn(async () => ({
      request_id: "request-1", action: "workflow.start", action_level: 2,
      command_digest: "sha256:aa", target_digest: "sha256:bb", args_digest: "sha256:cc",
      requested_at: "2026-08-31T00:00:00.000Z", expires_at: "2026-08-31T00:10:00.000Z",
      status: "pending", target: { environment: "local" }, args: {},
    })),
    decideRemote: vi.fn(async () => ({ challenge_id: "challenge-1" })),
  };
}

describe("SecurityPage", () => {
  it("loads a remote command and exposes approve and reject without treating a session as success", async () => {
    const user = userEvent.setup();
    const api = client();
    render(<SecurityPage client={api} />);
    expect(screen.getByRole("heading", { name: "보안" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Request ID"), "request-1");
    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText("workflow.start")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.decideRemote).toHaveBeenCalledWith("request-1", "approve");
    expect(screen.queryByText("approved")).not.toBeInTheDocument();
  });
});
