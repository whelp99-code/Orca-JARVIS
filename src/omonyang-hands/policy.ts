/**
 * Owner rule: only mail send, Notion writes that change amounts/dates/status,
 * tax transmission, and payment need approval. Everything else is audit-only.
 * Rejected alternative: gate every workboard status edit. That is not a Notion write.
 */
export const APPROVAL_KINDS = ["mail.send", "notion.write", "tax.transmit", "payment"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const HANDS_TOOLS = [
  "jarvis.request_approval",
  "jarvis.approval_status",
  "sb.remember",
  "sb.search",
  "sb.read",
  "mail.draft",
  "calendar.list",
  "calendar.create_draft",
  "workboard.list",
  "workboard.update",
] as const;
export type HandsTool = (typeof HANDS_TOOLS)[number];

/** MCP wire names (SEP tool-name charset). Contract ids stay dotted. */
export const MCP_TOOL_NAMES: Readonly<Record<HandsTool, string>> = {
  "jarvis.request_approval": "jarvis_request_approval",
  "jarvis.approval_status": "jarvis_approval_status",
  "sb.remember": "sb_remember",
  "sb.search": "sb_search",
  "sb.read": "sb_read",
  "mail.draft": "mail_draft",
  "calendar.list": "calendar_list",
  "calendar.create_draft": "calendar_create_draft",
  "workboard.list": "workboard_list",
  "workboard.update": "workboard_update",
};

export type ApprovalMode = "log" | "approval";

export function approvalMode(tool: HandsTool): ApprovalMode {
  switch (tool) {
    case "jarvis.request_approval":
    case "jarvis.approval_status":
    case "sb.remember":
    case "sb.search":
    case "sb.read":
    case "mail.draft":
    case "calendar.list":
    case "calendar.create_draft":
    case "workboard.list":
    case "workboard.update":
      return "log";
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

export function isApprovalKind(value: string): value is ApprovalKind {
  return (APPROVAL_KINDS as readonly string[]).includes(value);
}
