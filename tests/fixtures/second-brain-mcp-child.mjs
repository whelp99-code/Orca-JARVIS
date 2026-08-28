#!/usr/bin/env node
/* global Buffer, process, queueMicrotask */
import { appendFileSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.SB_CONFIG, "utf8"));
const protocolVersion = config.protocolVersion ?? "2025-11-25";
const tools = [
  ["sb_open_conflicts", {}], ["sb_read_page", { id: { type: "string" } }], ["sb_recent_changes", { days: { default: 7, type: "integer" } }],
  ["sb_remember", { content: { type: "string" }, title: { default: null, type: ["string", "null"] } }], ["sb_search", { limit: { default: 10, type: "integer" }, query: { type: "string" } }],
].map(([name, properties]) => ({ name, inputSchema: { type: "object", properties, required: name === "sb_read_page" ? ["id"] : name === "sb_remember" ? ["content"] : name === "sb_search" ? ["query"] : [], additionalProperties: false } }));
let input = ""; let calls = 0; let heldToolsId; const held = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolResult = (id, value) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } });
const release = () => { if (heldToolsId) { send({ jsonrpc: "2.0", id: heldToolsId, result: { tools: config.tools ?? tools } }); heldToolsId = undefined; } const entries = [...held]; const ordered = config.releaseForward ? entries : entries.reverse(); if (config.coalesceResponses) process.stdout.write(ordered.map(([id, value]) => `${JSON.stringify(toolResult(id, value))}\n`).join("")); else for (const [id, value] of ordered) send(toolResult(id, value)); held.clear(); };
process.on("SIGUSR1", release);
if (config.ignoreTerm) process.on("SIGTERM", () => { appendFileSync(config.receipt, `${JSON.stringify({ event: "signal", signal: "SIGTERM" })}\n`); process.stderr.write("signal\n"); });
process.stdin.on("data", chunk => {
  input += chunk.toString("utf8");
  for (;;) {
    const newline = input.indexOf("\n"); if (newline < 0) break;
    const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); if (config.wireReceipts) { appendFileSync(config.receipt, `${JSON.stringify({ event: "frame", method: message.method })}\n`); if (message.method === "notifications/cancelled") process.stderr.write("wire\n"); }
    if (message.method === "initialize") {
      if (config.mode === "hang-initialize") continue;
      const serverInfo = config.mode === "missing-server" ? undefined : config.mode === "invalid-server" ? { name: "second-brain" } : { name: "second-brain", version: "0.1.0" };
      const frame = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo } });
      if (config.mode === "partial") { process.stdout.write(frame.slice(0, 12)); queueMicrotask(() => process.stdout.write(`${frame.slice(12)}\n`)); }
      else if (config.mode === "partial-eof") { process.stdout.write(frame.slice(0, 20)); process.exit(0); }
      else if (config.mode === "malformed") process.stdout.write("{broken}\n");
      else if (config.mode === "invalid-utf8") process.stdout.write(Buffer.from([0xff, 0x0a]));
      else if (config.mode === "exact-max" || config.mode === "max-plus-one") { const size = 1024 * 1024 + Number(config.mode === "max-plus-one"); process.stdout.write(`${frame}${" ".repeat(size - Buffer.byteLength(frame))}\n`); }
      else if (config.mode === "crlf") process.stdout.write(`${frame}\r\n`);
      else if (config.mode === "oversize") process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
      else send(JSON.parse(frame));
    } else if (message.method === "tools/list") {
      if (config.mode === "hold-tools") { heldToolsId = message.id; process.stderr.write("tools\n"); continue; }
      if (config.mode === "hang-tools") continue;
      const availableTools = config.tools ?? tools; const listed = config.mode === "malformed-tool" ? [null, ...availableTools.slice(1)] : config.badTools ? availableTools.slice(1) : availableTools;
      send({ jsonrpc: "2.0", id: message.id, result: { tools: listed } });
    } else if (message.method === "tools/call") {
      calls += 1; const { name, arguments: args } = message.params;
      if (config.receipt) { appendFileSync(config.receipt, `${JSON.stringify({ event: "call", name, calls, id: message.id })}\n`); process.stderr.write("state\n"); }
      const priorCalls = config.receipt ? readFileSync(config.receipt, "utf8").split(`"name":${JSON.stringify(name)}`).length - 1 : calls;
      if (args?.crash || (args?.crashOnce && priorCalls === 1)) process.exit(23); if (args?.hang) continue;
      const values = { sb_search: args?.empty ? { results: [] } : { results: [{ page_id: "wiki/example", score: 1, section: "Intro", snippet: args.query }] }, sb_read_page: { frontmatter: { id: args.id }, body: "example body" }, sb_recent_changes: args?.empty ? { changes: [] } : { changes: [{ page_id: "wiki/example", change: "added", date: "2026-08-28" }] }, sb_open_conflicts: args?.empty ? { conflicts: [] } : { conflicts: [{ conflict_id: "c", page_id: "wiki/example", summary: "example" }] }, sb_remember: { inbox_path: "inbox/example.md" } };
      if (args?.stderrBytes) process.stderr.write("s".repeat(args.stderrBytes));
      if (args?.hold) held.set(message.id, values[name]);
      else if (args?.splitUtf8) { const frame = Buffer.from(`${JSON.stringify(toolResult(message.id, { results: [{ snippet: "한" }] }))}\n`); const split = frame.indexOf(Buffer.from("한")) + 1; process.stdout.write(frame.subarray(0, split)); queueMicrotask(() => process.stdout.write(frame.subarray(split))); }
      else if (args?.envelope === "extra") send({ ...toolResult(message.id, values[name]), extra: true });
      else if (args?.envelope === "both") send({ ...toolResult(message.id, values[name]), error: { code: -1, message: "bad" } });
      else if (args?.envelope === "missing") send({ jsonrpc: "2.0", id: message.id });
      else if (args?.envelope === "numeric-id") send({ jsonrpc: "2.0", id: 1, result: values[name] });
      else if (args?.envelope === "primitive") process.stdout.write("1\n");
      else if (args?.envelope === "array") process.stdout.write("[]\n");
      else if (args?.envelope === "notification") send({ jsonrpc: "2.0", method: "notifications/message", params: {} });
      else if (args?.envelope === "request") send({ jsonrpc: "2.0", id: message.id, method: "ping", params: {} });
      else if (args?.envelope === "old-id") send({ jsonrpc: "2.0", id: "0:1", result: values[name] });
      else if (args?.envelope === "error") send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "token=raw-secret" } });
      else if (args?.unmatched) send({ jsonrpc: "2.0", id: "unknown", result: {} });
      else if (args?.duplicate) { const frame = `${JSON.stringify(toolResult(message.id, values[name]))}\n`; process.stdout.write(`${frame}${frame}`); }
      else send(toolResult(message.id, values[name]));
    }
  }
});
