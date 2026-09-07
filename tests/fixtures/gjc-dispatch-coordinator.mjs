#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

// A strict, local protocol fixture. It never invokes an agent or a host coordinator.
assert.deepEqual(process.argv.slice(2), ["mcp-serve", "coordinator"]);
const frames = readFileSync(0, "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.equal(frames[0].method, "initialize");
assert.equal(frames[1].method, "notifications/initialized");
assert.equal(frames[2].method, "tools/call");
const { name, arguments: args } = frames[2].params;
let body;
if (name === "gjc_coordinator_send_prompt") {
  assert.deepEqual(Object.keys(args).sort(), ["allow_mutation", "idempotency_key", "prompt", "session_id"]);
  assert.equal(args.allow_mutation, true);
  assert.equal(args.session_id, "s");
  assert.equal(typeof args.idempotency_key, "string");
  assert.equal(JSON.parse(args.prompt).kind, "jarvis_authorized_continuation");
  body = { ok: true, turn: { session_id: "s", turn_id: "fixture-turn", status: "accepted" } };
} else if (name === "gjc_coordinator_read_turn") {
  assert.deepEqual(args, { session_id: "s", turn_id: "fixture-turn" });
  body = { ok: true, turn: { ...args, status: "completed" } };
} else {
  assert.equal(name, "gjc_coordinator_list_questions");
  body = { questions: [] };
}
appendFileSync(process.env.JARVIS_TEST_GJC_LOG, `${JSON.stringify({ name, args })}\n`);
for (const frame of [
  { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05",
    serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } },
  { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
]) process.stdout.write(`${JSON.stringify(frame)}\n`);
