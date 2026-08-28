#!/usr/bin/env node
/* global process, queueMicrotask */
import { appendFileSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.SB_CONFIG, "utf8"));
const protocolVersion = config.protocolVersion ?? "2026-07-28";
const tools = [
  ["sb_open_conflicts", {}],
  ["sb_read_page", { id: { type: "string" } }],
  ["sb_recent_changes", { days: { default: 7, type: "integer" } }],
  ["sb_remember", { content: { type: "string" }, title: { default: null, type: ["string", "null"] } }],
  ["sb_search", { limit: { default: 10, type: "integer" }, query: { type: "string" } }],
].map(([name, properties]) => ({ name, inputSchema: { type: "object", properties, required: name === "sb_read_page" ? ["id"] : name === "sb_remember" ? ["content"] : name === "sb_search" ? ["query"] : [], additionalProperties: false } }));
let input = "";
let calls = 0;
const held = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolResult = (id, value, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError } });
const result = (id, value, isError = false) => send(toolResult(id, value, isError));
const release = () => { for (const [id, value] of [...held].reverse()) result(id, value); held.clear(); };
process.on("SIGUSR1", release);
process.stdin.on("data", chunk => {
  input += chunk.toString("utf8");
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (config.mode === "hang-initialize") continue;
      const frame = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "second-brain", version: "0.1.0" } } });
      if (config.mode === "partial") { process.stdout.write(frame.slice(0, 12)); queueMicrotask(() => process.stdout.write(`${frame.slice(12)}\n`)); }
      else if (config.mode === "malformed") process.stdout.write("{broken}\n");
      else if (config.mode === "oversize") process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
      else send(JSON.parse(frame));
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: config.badTools ? tools.slice(1) : tools } });
    } else if (message.method === "tools/call") {
      calls += 1;
      const { name, arguments: args } = message.params;
      if (config.receipt) { appendFileSync(config.receipt, `${JSON.stringify({ event: "call", name, calls, id: message.id })}\n`); process.stderr.write("state\n"); }
      const priorCalls = config.receipt ? readFileSync(config.receipt, "utf8").split(`"name":${JSON.stringify(name)}`).length - 1 : calls;
      if (args?.crash || (args?.crashOnce && priorCalls === 1)) process.exit(23);
      if (args?.hang) continue;
      const values = {
        sb_search: args?.empty ? { results: [] } : { results: [{ page_id: "wiki/example", score: 1, section: "Intro", snippet: args.query }] },
        sb_read_page: { frontmatter: { id: args.id }, body: "example body" },
        sb_recent_changes: args?.empty ? { changes: [] } : { changes: [{ page_id: "wiki/example", change: "added", date: "2026-08-28" }] },
        sb_open_conflicts: args?.empty ? { conflicts: [] } : { conflicts: [{ conflict_id: "c", page_id: "wiki/example", summary: "example" }] },
        sb_remember: { inbox_path: "inbox/example.md" },
      };
      if (args?.hold) held.set(message.id, values[name]);
      else if (args?.unmatched) send({ jsonrpc: "2.0", id: "unknown", result: {} });
      else if (args?.duplicate) { const frame = `${JSON.stringify(toolResult(message.id, values[name]))}\n`; process.stdout.write(`${frame}${frame}`); }
      else result(message.id, values[name]);
    }
  }
});
