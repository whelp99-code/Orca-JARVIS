import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HandsError } from "./errors.js";
import type { HandsService } from "./hands.js";
import { HANDS_TOOLS, MCP_TOOL_NAMES, type HandsTool } from "./policy.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const schemas: Record<HandsTool, z.ZodType> = {
  "jarvis.request_approval": z.object({
    token: z.string().min(32),
    items: z.array(z.object({
      request_id: z.string().min(8).max(80).optional(),
      action_kind: z.enum(["mail.send", "notion.write", "tax.transmit", "payment"]),
      summary: z.string().min(1).max(240),
      payload_digest: digest,
      expires_in_seconds: z.number().int().min(900).max(7200),
      mail_draft_id: z.string().min(1).max(80).optional(),
    }).strict()).min(1).max(20),
  }).strict(),
  "jarvis.approval_status": z.object({
    token: z.string().min(32),
    request_id: z.string().min(8).max(80),
    payload_digest: digest.optional(),
  }).strict(),
  "sb.remember": z.object({
    token: z.string().min(32),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
    page_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  }).strict(),
  "sb.search": z.object({
    token: z.string().min(32),
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(32).optional(),
  }).strict(),
  "sb.read": z.object({
    token: z.string().min(32),
    page_id: z.string().min(1).max(64),
  }).strict(),
  "mail.draft": z.object({
    token: z.string().min(32),
    operation_id: z.string().min(1).max(80),
    to: z.string().min(1).max(320),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
  }).strict(),
  "calendar.list": z.object({
    token: z.string().min(32),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict(),
  "calendar.create_draft": z.object({
    token: z.string().min(32),
    title: z.string().min(1).max(200),
    starts_at: z.string().min(1).max(40),
    ends_at: z.string().min(1).max(40),
    note: z.string().max(1000).optional(),
  }).strict(),
  "workboard.list": z.object({ token: z.string().min(32) }).strict(),
  "workboard.update": z.object({
    token: z.string().min(32),
    card_id: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    status: z.enum(["open", "doing", "blocked", "done"]),
    note: z.string().max(1000).optional(),
  }).strict(),
};

function fail(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const code = error instanceof HandsError ? error.code : "UNAVAILABLE";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code } }) }] };
}

export function createOmonyangHandsMcp(service: HandsService): McpServer {
  const server = new McpServer({ name: "jarvis-omonyang-hands", version: "1.0.0" });
  for (const tool of HANDS_TOOLS) {
    server.registerTool(MCP_TOOL_NAMES[tool], {
      description: `${tool}. 오모냥 calls JARVIS. Send is not a tool. Approval kinds stay in jarvis_request_approval.`,
      inputSchema: schemas[tool],
      annotations: {
        readOnlyHint: tool.endsWith(".list") || tool.endsWith(".search") || tool.endsWith(".read") || tool === "jarvis.approval_status",
        destructiveHint: false,
        openWorldHint: false,
      },
    }, async (input) => {
      try {
        const body = input as { token: string };
        const result = await service.call(tool, input, body.token);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return fail(error);
      }
    });
  }
  return server;
}
