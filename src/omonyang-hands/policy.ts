/** Owner rule: only these kinds need approval. They are not executable tools. */
export const APPROVAL_KINDS = ["mail.send", "notion.write", "tax.transmit", "payment"] as const;

export const HANDS_TOOLS = [
  "jarvis.request_approval",
  "jarvis.approval_status",
  "sb.remember",
  "sb.search",
  "sb.read",
  "mail.draft",
  "workboard.list",
  "workboard.update",
] as const;
export type HandsTool = (typeof HANDS_TOOLS)[number];

export const MCP_TOOL_NAMES: Readonly<Record<HandsTool, string>> = {
  "jarvis.request_approval": "jarvis_request_approval",
  "jarvis.approval_status": "jarvis_approval_status",
  "sb.remember": "sb_remember",
  "sb.search": "sb_search",
  "sb.read": "sb_read",
  "mail.draft": "mail_draft",
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
    case "workboard.list":
    case "workboard.update":
      return "log";
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}
