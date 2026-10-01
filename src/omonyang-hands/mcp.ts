import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HandsError } from "./errors.js";
import type { HandsService } from "./hands.js";
import { HANDS_TOOLS, MCP_TOOL_NAMES, type HandsTool } from "./policy.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const item = z.object({
  action_kind: z.enum(["mail.send", "notion.write", "tax.transmit", "payment"]),
  summary: z.string().min(1).max(240),
  payload_digest: digest,
  mail_draft_id: z.string().uuid().optional(),
  notion_effect: z.enum(["create", "delete", "amount", "date", "status", "partner"]).optional(),
}).strict();

const schemas: Record<HandsTool, z.ZodType> = {
  "jarvis.request_approval": z.object({
    token: z.string().min(32),
    request_id: z.string().min(8).max(128),
    batch_summary: z.string().min(1).max(240),
    expires_in_seconds: z.number().int().min(900).max(7200),
    items: z.array(item).min(1).max(50),
  }).strict(),
  "jarvis.approval_status": z.object({
    token: z.string().min(32),
    request_id: z.string().min(8).max(128),
    batch_digest: digest,
  }).strict(),
  "sb.remember": z.object({
    token: z.string().min(32),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(8000),
    request_id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  }).strict(),
  "sb.search": z.object({
    token: z.string().min(32),
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(32).optional(),
  }).strict(),
  "sb.read": z.object({
    token: z.string().min(32),
    page_id: z.string().min(1).max(128),
  }).strict(),
  "mail.draft": z.object({
    token: z.string().min(32),
    operation_id: z.string().min(1).max(80),
    to: z.string().min(1).max(320),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
  }).strict(),
  "workboard.list": z.object({ token: z.string().min(32) }).strict(),
  "workboard.update": z.object({
    token: z.string().min(32),
    event: z.record(z.string(), z.unknown()),
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
      description: `${tool}. Approvals are external.delegate in the owner inbox. sb_remember requires request_id; reuse the same id when retrying. Outcome codes pass through.`,
      inputSchema: schemas[tool],
      annotations: {
        readOnlyHint: tool.endsWith(".list") || tool.endsWith(".search") || tool.endsWith(".read") || tool === "jarvis.approval_status",
        destructiveHint: false,
        openWorldHint: tool.startsWith("sb."),
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
