import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sb-remember-fixture", version: "1.0.0" });
const codes = {
  WRITTEN: { code: "WRITTEN", written: true, delivery: "written", inbox_path: "inbox/note.md" },
  NOTHING_WRITTEN: { code: "NOTHING_WRITTEN", written: false, delivery: "not_written", cause: "NOTHING_WRITTEN" },
  WRITTEN_WITH_FOLLOWUP_ERROR: { code: "WRITTEN_WITH_FOLLOWUP_ERROR", written: true, delivery: "written", path: "inbox/note.md" },
  WRITE_OUTCOME_UNKNOWN: { code: "WRITE_OUTCOME_UNKNOWN", written: null, delivery: "unknown" },
};

server.registerTool("sb_remember", {
  description: "fixture",
  inputSchema: z.object({ title: z.string(), content: z.string() }).strict(),
}, async (input) => {
  const outcome = codes[input.title] ?? codes.WRITTEN;
  return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
});
server.registerTool("sb_search", {
  description: "fixture",
  inputSchema: z.object({ query: z.string(), limit: z.number().optional() }).strict(),
}, async (input) => ({ content: [{ type: "text", text: JSON.stringify({ results: [{ page_id: "p1", title: input.query }] }) }] }));
server.registerTool("sb_read_page", {
  description: "fixture",
  inputSchema: z.object({ page_id: z.string() }).strict(),
}, async (input) => ({ content: [{ type: "text", text: JSON.stringify({ page_id: input.page_id, body: "from-sb" }) }] }));

await server.connect(new StdioServerTransport());
