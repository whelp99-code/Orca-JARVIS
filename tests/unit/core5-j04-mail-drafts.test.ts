import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { personalConnectorDefinition } from "../../src/personal-connector-definitions.js";
import {
  CORE5_INTEGRATION_AUDIENCE,
  Core5CapabilityRegistry,
  Core5MailDraftGateway,
  Core5MailDraftStore,
  Core5OperationLedger,
  cardStateFromMailDraft,
  mailReviewHref,
  parseCommandEnvelope,
  type CommandEnvelope,
  type MailDraftHttp,
} from "../../src/integration/index.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-09-20T12:00:00.000Z");

function envelope(): CommandEnvelope {
  return parseCommandEnvelope({
    schema_version: 1,
    operation_id: "op:mail.draft:reply-1",
    attempt_id: "att:j04-1",
    lease_fence: "fence:j04-1",
    capability: "mail.draft",
    payload: {
      request_id: "req_jarvis_draft_01",
      to: ["human@example.com"],
      subject: "Draft for review",
      body_text: "Please review in Mail UI.",
    },
    caller: {
      principal: "operator:test",
      workspace: "ws:jarvis-shadow",
      purpose: "mail_draft",
      expiry: "2027-01-01T00:00:00.000Z",
      audience: CORE5_INTEGRATION_AUDIENCE,
    },
  });
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    expect((error as JarvisError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

class RecordingMailHttp implements MailDraftHttp {
  readonly calls: Array<{ method: string; path: string }> = [];
  draft = {
    draft_id: "11111111-1111-1111-1111-111111111111",
    status: "needs_approval",
    owner_principal: "agent:jarvis",
    payload_digest: "abc",
    failure_reason: null as string | null,
    uncertain: false,
  };

  async request(input: { method: "GET" | "POST"; path: string; body?: unknown }) {
    this.calls.push({ method: input.method, path: input.path });
    if (input.path.endsWith("/approve") || input.path.endsWith("/cancel")) {
      throw new Error("MAIL_PATH_MUST_NOT_BE_CALLED");
    }
    return { status: input.method === "POST" ? 201 : 200, body: { draft: this.draft } };
  }
}

async function opened(env: NodeJS.ProcessEnv, http = new RecordingMailHttp()) {
  const db = await migratedTestDatabase(tempDb());
  const gateway = new Core5MailDraftGateway(
    new Core5CapabilityRegistry(env),
    new Core5OperationLedger(db.db),
    new Core5MailDraftStore(db.db),
    http,
    "https://mail.example.invalid",
    () => now,
  );
  return { db, gateway, http };
}

describe("core5 J04 card states", () => {
  it("maps Mail statuses onto four distinct cards", () => {
    expect(cardStateFromMailDraft({ draft_id: "d", status: "needs_approval" })).toBe("approval_required");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "approved" })).toBe("approval_required");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "sending" })).toBe("sending");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "sending", uncertain: true })).toBe("result_unconfirmed");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "sending", failure_reason: "GRAPH_ACCEPTANCE_UNKNOWN" })).toBe("result_unconfirmed");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "failed" })).toBe("follow_up_needed");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "needs_clarification" })).toBe("follow_up_needed");
    expect(cardStateFromMailDraft({ draft_id: "d", status: "sent" })).toBeNull();
    expect(cardStateFromMailDraft({ draft_id: "d", status: "cancelled" })).toBeNull();
  });

  it("points humans at the existing Mail review UI", () => {
    expect(mailReviewHref("https://mail.example.invalid/app", "11111111-1111-1111-1111-111111111111"))
      .toBe("https://mail.example.invalid/#sendDraftReview?draft=11111111-1111-1111-1111-111111111111");
  });
});

describe("core5 J04 gateway", () => {
  it("stays off by default and never registers mail.send", async () => {
    const { db, gateway } = await opened({});
    expect(personalConnectorDefinition("mail").configured).toBe(false);
    expectCode(() => new Core5CapabilityRegistry({}).get("mail.send"), "CORE5_LIVE_SEND_NOT_REGISTERED");
    await expect(gateway.create(envelope())).rejects.toMatchObject({ code: "CORE5_INTEGRATION_DISABLED" });
    db.close();
  });

  it("creates a JARVIS draft and stores a review reference without approve/send", async () => {
    const { db, gateway, http } = await opened({ CORE5_INTEGRATION_ENABLED: "1" });
    const card = await gateway.create(envelope());
    expect(card.card_state).toBe("approval_required");
    expect(card.owner_principal).toBe("agent:jarvis");
    expect(card.review_href).toContain("#sendDraftReview?draft=");
    expect(http.calls).toEqual([{ method: "POST", path: "/api/mail/send-drafts" }]);
    expectCode(() => gateway.approve(), "CORE5_MAIL_HUMAN_OWNED");
    expectCode(() => gateway.send(), "CORE5_MAIL_HUMAN_OWNED");
    expectCode(() => gateway.cancel(), "CORE5_MAIL_HUMAN_OWNED");
    expectCode(() => gateway.assertHumanOwnedPath("/api/mail/send-drafts/x/approve"), "CORE5_MAIL_HUMAN_OWNED");
    db.close();
  });

  it("refreshes GET-only into sending, unconfirmed, and follow_up cards", async () => {
    const http = new RecordingMailHttp();
    const { db, gateway } = await opened({ CORE5_INTEGRATION_ENABLED: "1" }, http);
    await gateway.create(envelope());
    http.draft = { ...http.draft, status: "sending", failure_reason: null, uncertain: false };
    expect((await gateway.refresh(envelope().operation_id)).card_state).toBe("sending");
    http.draft = { ...http.draft, status: "sending", uncertain: true, failure_reason: "GRAPH_ACCEPTANCE_UNKNOWN" };
    expect((await gateway.refresh(envelope().operation_id)).card_state).toBe("result_unconfirmed");
    http.draft = { ...http.draft, status: "failed", uncertain: false, failure_reason: "GRAPH_REJECTED" };
    expect((await gateway.refresh(envelope().operation_id)).card_state).toBe("follow_up_needed");
    expect(http.calls.every(call => !call.path.includes("approve") && !call.path.includes("cancel"))).toBe(true);
    expect(http.calls.filter(call => call.method === "GET").every(call => call.path.endsWith(http.draft.draft_id))).toBe(true);
    db.close();
  });
});

describe("core5 J04 docs", () => {
  it("records M04 unblocked and keeps send off the product path", () => {
    const hold = readFileSync(fileURLToPath(new URL("../../docs/core5/J04-HOLD.md", import.meta.url)), "utf8");
    expect(hold).toMatch(/unblocked by Mail M04/);
    expect(hold).toMatch(/6a9c26f/);
    const doc = fileURLToPath(new URL("../../docs/core5/J04.md", import.meta.url));
    expect(existsSync(doc)).toBe(true);
    expect(readFileSync(doc, "utf8")).toMatch(/JARVIS has no approve\/send\/cancel/);
    const productIndex = readFileSync(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "utf8");
    expect(productIndex).not.toMatch(/mail\.send/);
    expect(personalConnectorDefinition("mail").configured).toBe(false);
  });
});
