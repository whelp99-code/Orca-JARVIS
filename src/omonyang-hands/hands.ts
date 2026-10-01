import { ControlPlane, type ControlCommandRequestInput } from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import {
  externalDelegateBatchDigest,
  parseExternalDelegateItems,
} from "../external-delegate.js";
import { Core5CapabilityRegistry } from "../integration/capability-registry.js";
import { Core5MailDraftGateway, type MailDraftHttp } from "../integration/mail-draft-gateway.js";
import { Core5MailDraftStore } from "../integration/mail-draft-store.js";
import { Core5OperationLedger } from "../integration/operation-ledger.js";
import type { CommandEnvelope } from "../integration/types.js";
import { WorkboardStore } from "../workboard/store.js";
import { assertBind, OMONYANG_AGENT, tokenMatches, type AgentTokenFile } from "./auth.js";
import { HandsError, type HandsErrorCode } from "./errors.js";
import { approvalMode, type HandsTool } from "./policy.js";
import type { SbMcp } from "./sb-client.js";
import { sha256Digest } from "./digest.js";

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

export class HandsService {
  private readonly hits = new Map<string, Limit>();
  private readonly board: WorkboardStore;

  constructor(
    private readonly token: AgentTokenFile,
    private readonly authority: AuthorityDb,
    private readonly sb: SbMcp,
    private readonly bind: string,
    private readonly now: () => Date = () => new Date(),
    private readonly mail?: { readonly http: MailDraftHttp; readonly origin: string },
  ) {
    assertBind(bind);
    this.board = new WorkboardStore(authority.db);
  }

  async call(tool: HandsTool, input: unknown, presentedToken: string): Promise<HandsCallResult> {
    const at = this.now().toISOString();
    const digest = sha256Digest(input);
    try {
      if (!tokenMatches(this.token.token, presentedToken)) throw new HandsError("AUTH_REQUIRED");
      this.rate(tool);
      const data = await this.dispatch(tool, record(input, "input"));
      this.audit(at, tool, digest, sha256Digest(data), null);
      return { ok: true, tool, approval: "log", data };
    } catch (error) {
      const code: HandsErrorCode = error instanceof HandsError ? error.code : "UNAVAILABLE";
      try { this.audit(at, tool, digest, null, code); } catch { throw new HandsError("AUDIT_FAILED"); }
      if (error instanceof HandsError) throw error;
      if (error instanceof JarvisError && error.code === "CONTROL_COMMAND_REPLAY_CONFLICT") throw new HandsError("CONFLICT");
      if (error instanceof JarvisError) throw new HandsError("VALIDATION", error.code);
      throw new HandsError("UNAVAILABLE");
    }
  }

  private audit(at: string, tool: HandsTool, inputDigest: string, outputDigest: string | null, errorCode: string | null): void {
    this.authority.db.prepare(
      "INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)",
    ).run("omonyang_hands_call", OMONYANG_AGENT, JSON.stringify({
      tool, input_digest: inputDigest, output_digest: outputDigest, error_code: errorCode, approval: approvalMode(tool),
    }), at);
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
      case "sb.remember": return { outcome: await this.sb.call("sb_remember", {
        title: text(input["title"], "title", 200),
        content: text(input["content"], "content", 8000),
      }) };
      case "sb.search": return { outcome: await this.sb.call("sb_search", {
        query: text(input["query"], "query", 512),
        limit: input["limit"] === undefined ? 8 : input["limit"],
      }) };
      case "sb.read": return { outcome: await this.sb.call("sb_read_page", {
        page_id: text(input["page_id"], "page_id", 128),
      }) };
      case "mail.draft": return this.mailDraft(input);
      case "workboard.list": return { works: this.board.works() };
      case "workboard.update": return { result: this.board.ingest(input["event"]) };
      default: {
        const exhaustive: never = tool;
        return exhaustive;
      }
    }
  }

  private requestApproval(input: Record<string, unknown>): Record<string, unknown> {
    const items = parseExternalDelegateItems(input["items"]);
    const batchDigest = externalDelegateBatchDigest(items);
    const summary = text(input["batch_summary"], "batch_summary", 240);
    const requestId = text(input["request_id"], "request_id", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestId)) throw new HandsError("VALIDATION", "request_id");
    const expiresIn = input["expires_in_seconds"];
    if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 900 || expiresIn > 7200) {
      throw new HandsError("VALIDATION", "expires_in_seconds");
    }
    const requested = this.now().toISOString();
    const command: ControlCommandRequestInput = {
      schema_version: 1,
      request_id: requestId,
      action: "external.delegate",
      action_level: 3,
      target: { environment: "external", system: "grok-bot" },
      args: {
        source: "grok-bot",
        action_kind: items.length === 1 ? items[0]?.action_kind : "batch",
        summary,
        batch_summary: summary,
        batch_digest: batchDigest,
        payload_digest: batchDigest,
        items,
      },
      reversible: false,
      requested_by: "agent:grok-bot",
      requested_at: requested,
      expires_at: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
      nonce: `delegate:${requestId}`,
    };
    const staged = new ControlPlane(this.authority).stage(command, this.now());
    return {
      request_id: staged.request_id,
      command_digest: staged.command_digest,
      batch_digest: batchDigest,
      state: staged.state,
    };
  }

  private approvalStatus(input: Record<string, unknown>): Record<string, unknown> {
    const requestId = text(input["request_id"], "request_id", 128);
    const batchDigest = text(input["batch_digest"], "batch_digest", 71);
    const row = this.authority.db.prepare(
      "SELECT state, command_digest, args_json, expires_at FROM control_command_requests WHERE request_id = ? AND action = 'external.delegate'",
    ).get(requestId) as { state: string; command_digest: string; args_json: string; expires_at: string } | undefined;
    if (row === undefined) throw new HandsError("NOT_FOUND", requestId);
    const args = JSON.parse(row.args_json) as { batch_digest?: string };
    if (args.batch_digest !== batchDigest) throw new HandsError("NOT_FOUND", requestId);
    if (row.state === "pending" && Date.parse(row.expires_at) <= this.now().getTime()) {
      return { request_id: requestId, state: "expired", batch_digest: batchDigest };
    }
    return {
      request_id: requestId,
      state: row.state,
      command_digest: row.command_digest,
      batch_digest: batchDigest,
      manual_wait: row.state === "approved",
    };
  }

  private async mailDraft(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input["send"] === true) throw new HandsError("FORBIDDEN_SEND");
    if (!this.mail) throw new HandsError("UNAVAILABLE", "mail");
    const gateway = new Core5MailDraftGateway(
      new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" }),
      new Core5OperationLedger(this.authority.db),
      new Core5MailDraftStore(this.authority.db),
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
}
