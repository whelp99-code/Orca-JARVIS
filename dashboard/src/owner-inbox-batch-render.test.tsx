import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwnerInboxPanel } from "./owner-inbox-panel.js";

const DIGEST = "sha256:" + "ab".repeat(32);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("owner inbox batch list", () => {
  it.each([false, true])("keeps the company proof deadline visible when needs_review=%s", async needsReview => {
    const requestId = "company-handoff:v1:proof-window:1";
    const expiresAt = "2026-10-13T00:10:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/v1/session"
      ? json({ csrf_token: "test-csrf" })
      : json({ schema_version: 1, passkey_enrolled: true, items: [{
        request_id: requestId, action: "company.candidate.transition",
        summary: "company deadline fixture", command_digest: DIGEST, expires_at: expiresAt,
        manual_wait: true, expired: needsReview, needs_review: needsReview, company_candidate: {
          provider_instance_id: "provider:fixture", workspace_id: "12345678-1234-4234-8234-123456789abc",
          candidate_id: "deadline-fixture", content_digest: DIGEST, owner: "principal:owner",
          projects: ["project:fixture"], policy_revision: "policy:fixture", deletion_sequence: 0,
          deletion_set_root: DIGEST, processor_principal_id: "principal:processor", status: "imported",
        },
      }] })));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText(requestId)).toBeInTheDocument();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(expiresAt);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("exposes the executable request ID on a read-only company rejection", async () => {
    const requestId = "company-handoff:v1:operator-visible-rejection:1";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/v1/session"
      ? json({ csrf_token: "test-csrf" })
      : json({ schema_version: 1, passkey_enrolled: true, items: [{
        request_id: requestId, action: "company.candidate.transition",
        summary: "synthetic rejection", command_digest: DIGEST, expires_at: "2026-10-14T00:00:00.000Z",
        manual_wait: true, company_candidate: {
          provider_instance_id: "provider:fixture", workspace_id: "12345678-1234-4234-8234-123456789abc",
          candidate_id: "review-fixture", content_digest: DIGEST, owner: "principal:owner",
          projects: ["project:fixture"], policy_revision: "policy:fixture", deletion_sequence: 0,
          deletion_set_root: DIGEST, processor_principal_id: "principal:processor", status: "imported",
        },
      }] })));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText(requestId)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders every batch item by index even when digests collide", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/session") return json({ csrf_token: "csrf-1" });
      return json({
        schema_version: 1,
        passkey_enrolled: true,
        items: [{
          request_id: "delegate-render-01",
          action: "external.delegate",
          summary: "묶음",
          command_digest: DIGEST,
          expires_at: "2026-10-02T03:30:00.000Z",
          expired: false,
          manual_wait: false,
          batch_items: [
            { action_kind: "mail.send", summary: "수신 a@example.com · 제목 하나", payload_digest: DIGEST },
            { action_kind: "payment", summary: "두 번째", payload_digest: DIGEST },
          ],
        }],
      });
    }));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText("메일 발송")).toBeInTheDocument();
    expect(screen.getByText("결제")).toBeInTheDocument();
    const rows = document.querySelectorAll("[data-item-index]");
    expect([...rows].map(row => row.getAttribute("data-item-index"))).toEqual(["0", "1"]);
  });

  it("renders the exact company identity and access fence without treating it as a personal batch", async () => {
    const company = {
      provider_instance_id: "provider:company-fixture",
      workspace_id: "12345678-1234-4234-8234-123456789abc",
      candidate_id: "mail:candidate:company-fixture",
      content_digest: DIGEST, owner: "principal:owner", projects: ["project:company"],
      policy_revision: "policy:1", deletion_sequence: 2, deletion_set_root: DIGEST,
      processor_principal_id: "principal:company-processor", status: "imported",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/v1/session"
      ? json({ csrf_token: "csrf-company" })
      : json({ schema_version: 1, passkey_enrolled: true, items: [{
        request_id: "company-handoff:v1:fixture:1", action: "company.candidate.transition",
        summary: "company fixture", command_digest: DIGEST, expires_at: "2026-10-14T00:00:00.000Z",
        company_candidate: company,
      }] })));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText(company.candidate_id)).toBeInTheDocument();
    expect(screen.getByText(company.workspace_id)).toBeInTheDocument();
    expect(screen.getByText(company.processor_principal_id)).toBeInTheDocument();
    expect(document.querySelector("[data-batch]")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
