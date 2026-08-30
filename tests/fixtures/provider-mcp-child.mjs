#!/usr/bin/env node
/* global process */
import { createInterface } from "node:readline";

const tools = [
  "sb_provider_health",
  "sb_write_request",
  "sb_request_status",
  "sb_reconcile_write",
  "sb_restore_request",
  "sb_observe_artifact",
  "sb_export_history",
  "sb_open_conflicts",
  "sb_read_page",
  "sb_recent_changes",
  "sb_remember",
  "sb_search",
  "sb_run",
];
const digest = `sha256:${"a".repeat(64)}`;
const pageId = "terminal-work/candidate-child";
const records = new Map();

function receipt(requestId, status) {
  return {
    request_id: requestId,
    status,
    idempotent_replay: false,
    artifact_digest: digest,
    page_id: pageId,
    error_code: null,
    result: { status, artifact_digest: digest, page_id: pageId },
  };
}

function exactWriteRequest(args) {
  const request = args?.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const required = [
    "schema",
    "operation",
    "candidate_id",
    "closeout_id",
    "receipt_digest",
    "purpose",
    "sensitivity",
    "retention",
    "expected_prior_digest",
    "idempotency_key",
    "summary",
    "request_id",
  ];
  if (Object.keys(request).sort().join("\0") !== [...required].sort().join("\0")) return null;
  if (request.schema !== "second-brain-write-request-v1") return null;
  if (request.operation !== "remember" || request.request_id !== "outbox:child") return null;
  const summary = request.summary;
  if (!summary || summary.schema !== "terminal-work-summary-v1") return null;
  if (summary.memory_candidate_id !== request.candidate_id) return null;
  if (summary.jarvis_closeout_id !== request.closeout_id) return null;
  if (summary.jarvis_receipt_digest !== request.receipt_digest || summary.verified !== true) return null;
  return request;
}

function tool(name, args) {
  if (name === "sb_provider_health") {
    return {
      kind: "health",
      status: "ok",
      contract: "second-brain-provider-v1",
      version: "1",
      capabilities: ["approved_write_requests", "reconciliation"],
      detail: "fixture",
    };
  }
  if (name === "sb_write_request") {
    const request = exactWriteRequest(args);
    if (!request) throw new Error("fixture_invalid_write_request");
    const result = receipt(request.request_id, "applied");
    records.set(request.request_id, result);
    return result;
  }
  if (name === "sb_request_status") {
    const record = records.get(args.request_id);
    return record
      ? { kind: "request", ...record, history: [{ status: record.status }] }
      : { kind: "no_data", reason: "request_not_found" };
  }
  if (name === "sb_reconcile_write") {
    return records.get(args.request_id) ?? receipt(args.request_id, "accepted");
  }
  if (name === "sb_observe_artifact") {
    if (args.request_id !== "outbox:child" || args.digest !== digest || args.page_id !== pageId) {
      throw new Error("fixture_invalid_observation");
    }
    const result = receipt(args.request_id, "settled");
    records.set(args.request_id, result);
    return result;
  }
  if (name === "sb_restore_request") return receipt(args.request_id, "restored");
  if (name === "sb_export_history") return { schema: "fixture-export-v1", requests: [] };
  if (name === "sb_search") return { results: [] };
  if (name === "sb_recent_changes") return { changes: [] };
  if (name === "sb_open_conflicts") return { conflicts: [] };
  if (name === "sb_run") return { run_id: "fixture", status: "ok" };
  if (name === "sb_remember") return { inbox_path: "inbox/fixture.md" };
  if (name === "sb_read_page") return { frontmatter: {}, body: "" };
  throw new Error("fixture_unknown_tool");
}

function response(id, result, isError = false) {
  const payload = {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
  return { jsonrpc: "2.0", id, result: payload };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") continue;
  let envelope;
  try {
    if (request.method === "initialize") {
      envelope = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "second-brain", version: "fixture" },
        },
      };
    } else if (request.method === "tools/list") {
      envelope = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: tools.map((name) => ({
            name,
            inputSchema: { type: "object", additionalProperties: false },
          })),
        },
      };
    } else if (request.method === "tools/call") {
      envelope = response(
        request.id,
        tool(request.params.name, request.params.arguments ?? {}),
      );
    } else {
      envelope = { jsonrpc: "2.0", id: request.id, error: { code: -32601 } };
    }
  } catch (error) {
    envelope = response(request.id, {
      code: error instanceof Error ? error.message : "fixture_error",
    }, true);
  }
  if (request.id !== undefined) process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
