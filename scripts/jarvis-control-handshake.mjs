#!/usr/bin/env node
import { createInterface } from "node:readline";

const METHODS = [
  "capabilities.get",
  "command.request",
  "command.status",
  "approval.intent",
  "timeline.list",
  "timeline.subscribe",
  "worker.signal",
  "verification.run",
  "knowledge.query",
  "routine.manage",
  "evolution.propose",
];

function fail(request, code, message) {
  return {
    protocol: "jarvis-control",
    version: "1.0",
    id: `res-${request.id ?? "unknown"}`,
    traceId: request.traceId ?? "trace-unknown",
    generation: request.generation ?? "gen-unknown",
    sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    type: "response",
    replyTo: request.id ?? "missing",
    ok: false,
    error: { code, message, retryable: false },
  };
}

process.stderr.write("jarvis-control handshake starting\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify(fail({}, "invalid_request", "malformed_json"))}\n`);
    continue;
  }
  if (parsed.protocol !== "jarvis-control" || parsed.type !== "request" || parsed.method !== "capabilities.get") {
    process.stdout.write(`${JSON.stringify(fail(parsed, "invalid_request", "handshake"))}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({
    protocol: "jarvis-control",
    version: "1.0",
    id: "res-capabilities-handshake",
    traceId: parsed.traceId,
    generation: parsed.generation,
    sentAt: "2026-08-23T12:00:00.100Z",
    type: "response",
    replyTo: parsed.id,
    ok: true,
    payload: { methods: METHODS },
  })}\n`);
}
process.stderr.write("jarvis-control handshake done\n");
