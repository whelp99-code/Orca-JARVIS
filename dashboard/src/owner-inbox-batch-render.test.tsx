import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwnerInboxPanel } from "./owner-inbox-panel.js";

const DIGEST = "sha256:" + "ab".repeat(32);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("owner inbox batch list", () => {
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
            { action_kind: "mail.send", summary: "수신 a@example.com · 제목 하나", payload_digest: DIGEST, mail_draft_id: "11111111-1111-4111-8111-111111111111" },
            { action_kind: "payment", summary: "두 번째", payload_digest: DIGEST },
            { action_kind: "notion.write", summary: "일반적인 요약", payload_digest: DIGEST, notion_effect: "delete" },
          ],
        }],
      });
    }));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText("메일 발송")).toBeInTheDocument();
    expect(screen.getByText("결제")).toBeInTheDocument();
    const rows = document.querySelectorAll("[data-item-index]");
    expect([...rows].map(row => row.getAttribute("data-item-index"))).toEqual(["0", "1", "2"]);
    expect(document.querySelector("[data-mail-draft-id]")).toHaveAttribute("data-mail-draft-id", "11111111-1111-4111-8111-111111111111");
    expect(document.querySelector("[data-notion-effect]")).toHaveAttribute("data-notion-effect", "delete");
  });
});
