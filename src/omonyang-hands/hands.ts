import { randomUUID } from "node:crypto";
import type { AuthorityDb } from "../authority-db.js";
import { Core5CapabilityRegistry } from "../integration/capability-registry.js";
import { Core5MailDraftGateway, type MailDraftHttp } from "../integration/mail-draft-gateway.js";
import { Core5MailDraftStore } from "../integration/mail-draft-store.js";
import { Core5OperationLedger } from "../integration/operation-ledger.js";
import type { CommandEnvelope } from "../integration/types.js";
import { assertBind, OMONYANG_AGENT, tokenMatches, type AgentTokenFile } from "./auth.js";
import { HandsError, type HandsErrorCode } from "./errors.js";
import { approvalMode, isApprovalKind, type HandsTool } from "./policy.js";
import { sha256Digest, type HandsStore } from "./store.js";
import type { FileVault } from "./vault.js";

export type HandsCallResult = {
  readonly ok: true;
  readonly tool: HandsTool;
  readonly approval: "log";
  readonly data: Record<string, unknown>;
};

type Limit = { count: number; window: number };

const LIMITS: Readonly<Record<HandsTool, number>> = {
  "jarvis.request_approval": 10,
  "jarvis.approval_status": 60,
  "sb.remember": 20,
  "sb.search": 60,
  "sb.read": 60,
  "mail.draft": 20,
  "calendar.list": 60,
  "calendar.create_draft": 20,
  "workboard.list": 60,
  "workboard.update": 20,
};

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HandsError("VALIDATION", code);
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new HandsError("VALIDATION", key);
  return value;
}

function optionalText(input: Record<string, unknown>, key: string, max: number): string | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return text(input[key], key, max);
}

export class HandsService {
  private readonly hits = new Map<string, Limit>();

  constructor(
    private readonly token: AgentTokenFile,
    private readonly store: HandsStore,
    private readonly vault: FileVault,
    private readonly bind: string,
    private readonly now: () => Date = () => new Date(),
    private readonly mail?: { readonly authority: AuthorityDb; readonly http: MailDraftHttp; readonly origin: string },
  ) {
    assertBind(bind);
  }

  async call(tool: HandsTool, input: unknown, presentedToken: string): Promise<HandsCallResult> {
    const at = this.now().toISOString();
    const digest = sha256Digest(input);
    try {
      if (!tokenMatches(this.token.token, presentedToken)) throw new HandsError("AUTH_REQUIRED");
      this.rate(tool);
      const data = await this.dispatch(tool, record(input, "input"));
      this.store.audit({
        audit_id: `aud_${randomUUID()}`, at, agent: OMONYANG_AGENT, tool, input_digest: digest,
        output_digest: sha256Digest(data), error_code: null, approval: approvalMode(tool),
      });
      return { ok: true, tool, approval: "log", data };
    } catch (error) {
      const code: HandsErrorCode = error instanceof HandsError ? error.code : "UNAVAILABLE";
      try {
        this.store.audit({
          audit_id: `aud_${randomUUID()}`, at, agent: OMONYANG_AGENT, tool, input_digest: digest,
          output_digest: null, error_code: code, approval: approvalMode(tool),
        });
      } catch {
        throw new HandsError("AUDIT_FAILED");
      }
      throw error instanceof HandsError ? error : new HandsError("UNAVAILABLE");
    }
  }

  private rate(tool: HandsTool): void {
    const window = Math.floor(this.now().getTime() / 60_000);
    const key = `${tool}:${window}`;
    const current = this.hits.get(key) ?? { count: 0, window };
    if (current.count >= LIMITS[tool]) throw new HandsError("RATE_LIMITED", tool);
    this.hits.set(key, { count: current.count + 1, window });
  }

  private async dispatch(tool: HandsTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (tool) {
      case "jarvis.request_approval": return this.requestApproval(input);
      case "jarvis.approval_status": return this.approvalStatus(input);
      case "sb.remember": return this.remember(input);
      case "sb.search": return this.search(input);
      case "sb.read": return this.read(input);
      case "mail.draft": return this.mailDraft(input);
      case "calendar.list": return this.calendarList(input);
      case "calendar.create_draft": return this.calendarCreate(input);
      case "workboard.list": return this.workboardList();
      case "workboard.update": return this.workboardUpdate(input);
      default: {
        const exhaustive: never = tool;
        return exhaustive;
      }
    }
  }

  private requestApproval(input: Record<string, unknown>): Record<string, unknown> {
    const items = input["items"];
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw new HandsError("VALIDATION", "items");
    const batch_id = `batch_${randomUUID()}`;
    const requests = items.map(item => {
      const row = record(item, "item");
      const action_kind = text(row["action_kind"], "action_kind", 32);
      if (!isApprovalKind(action_kind)) throw new HandsError("VALIDATION", "action_kind");
      const staged = this.store.stageApproval({
        request_id: optionalText(row, "request_id", 80),
        batch_id,
        action_kind,
        summary: text(row["summary"], "summary", 240),
        payload_digest: text(row["payload_digest"], "payload_digest", 71),
        mail_draft_id: optionalText(row, "mail_draft_id", 80),
        requested_by: OMONYANG_AGENT,
        now: this.now(),
        expires_in_seconds: Number(row["expires_in_seconds"]),
      });
      return {
        request_id: staged.request_id,
        state: staged.state,
        action_kind: staged.action_kind,
        payload_digest: staged.payload_digest,
        expires_at: staged.expires_at,
      };
    });
    return { batch_id, requests };
  }

  private approvalStatus(input: Record<string, unknown>): Record<string, unknown> {
    const request_id = text(input["request_id"], "request_id", 80);
    const row = this.store.approval(request_id, this.now());
    if (!row) throw new HandsError("NOT_FOUND", request_id);
    const digest = optionalText(input, "payload_digest", 71);
    if (digest !== undefined && digest !== row.payload_digest) throw new HandsError("NOT_FOUND", request_id);
    return {
      request_id: row.request_id,
      state: row.state,
      action_kind: row.action_kind,
      summary: row.summary,
      payload_digest: row.payload_digest,
      expires_at: row.expires_at,
      manual_wait: row.state === "approved",
    };
  }

  private remember(input: Record<string, unknown>): Record<string, unknown> {
    const page = this.vault.remember({
      title: text(input["title"], "title", 200),
      body: text(input["body"], "body", 8000),
      page_id: optionalText(input, "page_id", 64),
    });
    return { page_id: page.page_id, title: page.title };
  }

  private search(input: Record<string, unknown>): Record<string, unknown> {
    const limit = input["limit"] === undefined ? 8 : Number(input["limit"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new HandsError("VALIDATION", "limit");
    const hits = this.vault.search(text(input["query"], "query", 512), limit);
    return { results: hits.map(page => ({ page_id: page.page_id, title: page.title, excerpt: page.body.slice(0, 240) })) };
  }

  private read(input: Record<string, unknown>): Record<string, unknown> {
    const page = this.vault.read(text(input["page_id"], "page_id", 64));
    return { page_id: page.page_id, title: page.title, body: page.body };
  }

  private async mailDraft(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input["send"] === true) throw new HandsError("FORBIDDEN_SEND");
    if (!this.mail) throw new HandsError("UNAVAILABLE", "mail");
    const gateway = new Core5MailDraftGateway(
      new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" }),
      new Core5OperationLedger(this.mail.authority.db),
      new Core5MailDraftStore(this.mail.authority.db),
      this.mail.http,
      this.mail.origin,
      this.now,
    );
    const operation_id = text(input["operation_id"], "operation_id", 80);
    const envelope: CommandEnvelope = {
      schema_version: 1,
      operation_id,
      attempt_id: `attempt_${operation_id}`,
      lease_fence: "1",
      capability: "mail.draft",
      payload: {
        to: text(input["to"], "to", 320),
        subject: text(input["subject"], "subject", 200),
        body: text(input["body"], "body", 8000),
      },
      caller: {
        principal: OMONYANG_AGENT,
        workspace: "local",
        purpose: "mail.draft",
        expiry: new Date(this.now().getTime() + 900_000).toISOString(),
        audience: "jarvis.integration",
      },
    };
    const card = await gateway.create(envelope);
    return {
      operation_id: card.operation_id,
      draft_id: card.draft_id,
      review_href: card.review_href,
      mail_status: card.mail_status,
      sent: false,
    };
  }

  private calendarList(input: Record<string, unknown>): Record<string, unknown> {
    const day = optionalText(input, "day", 10);
    const rows = this.store.db.prepare(
      "SELECT draft_id, title, starts_at, ends_at, note FROM omonyang_calendar_drafts ORDER BY starts_at, draft_id",
    ).all() as Array<{ draft_id: string; title: string; starts_at: string; ends_at: string; note: string }>;
    const drafts = day === undefined ? rows : rows.filter(row => row.starts_at.startsWith(day));
    return { drafts, transmitted: false };
  }

  private calendarCreate(input: Record<string, unknown>): Record<string, unknown> {
    const draft_id = `cal_${randomUUID()}`;
    const title = text(input["title"], "title", 200);
    const starts_at = text(input["starts_at"], "starts_at", 40);
    const ends_at = text(input["ends_at"], "ends_at", 40);
    if (!Number.isFinite(Date.parse(starts_at)) || !Number.isFinite(Date.parse(ends_at))) throw new HandsError("VALIDATION", "starts_at");
    const note = optionalText(input, "note", 1000) ?? "";
    this.store.db.prepare(
      "INSERT INTO omonyang_calendar_drafts(draft_id,title,starts_at,ends_at,note,created_at) VALUES(?,?,?,?,?,?)",
    ).run(draft_id, title, starts_at, ends_at, note, this.now().toISOString());
    return { draft_id, title, starts_at, ends_at, transmitted: false };
  }

  private workboardList(): Record<string, unknown> {
    const cards = this.store.db.prepare(
      "SELECT card_id, title, status, note, updated_at FROM omonyang_workboard_cards ORDER BY card_id",
    ).all();
    return { cards };
  }

  private workboardUpdate(input: Record<string, unknown>): Record<string, unknown> {
    const card_id = text(input["card_id"], "card_id", 80);
    const title = text(input["title"], "title", 200);
    const status = text(input["status"], "status", 32);
    const note = optionalText(input, "note", 1000) ?? "";
    if (!["open", "doing", "blocked", "done"].includes(status)) throw new HandsError("VALIDATION", "status");
    this.store.db.prepare(
      `INSERT INTO omonyang_workboard_cards(card_id,title,status,note,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(card_id) DO UPDATE SET title=excluded.title, status=excluded.status, note=excluded.note, updated_at=excluded.updated_at`,
    ).run(card_id, title, status, note, this.now().toISOString());
    return { card_id, title, status, notion_write: false };
  }
}
