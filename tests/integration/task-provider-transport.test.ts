import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskProviderFailure } from "../../src/task-provider-failure.js";
import { ClaudeTaskCandidateProvider } from "../../src/claude-task-provider.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function response(bytes: Buffer, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-provider-transport-")); roots.push(root);
  const path = join(root, "provider");
  await writeFile(path, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => {
    process.stdout.write(Buffer.from('${bytes.toString("base64")}', 'base64')); process.exitCode = ${exitCode};
  });\n`, { mode: 0o700 });
  return new ClaudeTaskCandidateProvider(path).generate({ provider: "claude", execution_plan_digest: "fixture",
    prompt: "fixture", output_schema: {}, timeout_ms: 5000, max_output_bytes: 4096 });
}
const prefix = Buffer.from('{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"');
const suffix = Buffer.from('"}}');

it.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]].map(bytes => ({ bytes })))(
  "rejects malformed UTF-8 response bytes $bytes instead of repairing candidate content", async ({ bytes }) => {
    await expect(response(Buffer.concat([prefix, Buffer.from(bytes), suffix]))).rejects.toThrow("TASK_PROVIDER_RESULT_INVALID");
  });

it("preserves valid Korean, astral Unicode and an intentional replacement character exactly", async () => {
  const content = "한글 🧠 �";
  const bytes = Buffer.concat([prefix, Buffer.from(content), suffix]);
  expect(await response(bytes)).toEqual({ output: { text: content }, output_bytes: bytes.length,
    usage: { schema_version: 1, source: "claude_result", scope: "single_invocation_main_loop",
      tokens: { status: "missing" }, estimated_cost: { status: "missing" } } });
});


it("preserves result usage separately from generated candidate data", async () => {
  const bytes = Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    structured_output: { text: "candidate" }, usage: { input_tokens: 12, output_tokens: 8,
      cache_read_input_tokens: 100, cache_creation_input_tokens: 25 }, total_cost_usd: 0.0123 }));
  const result = await response(bytes);
  expect(result.output).toEqual({ text: "candidate" });
  expect(result.usage).toMatchObject({ tokens: { status: "reported", input_tokens: 12, output_tokens: 8,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 25 }, estimated_cost: { status: "reported", usd: 0.0123 } });
});

it("does not turn invalid telemetry into zero or reject a valid candidate", async () => {
  const bytes = Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    structured_output: { text: "candidate" }, usage: { input_tokens: -1 }, total_cost_usd: "0" }));
  const result = await response(bytes);
  expect(result.output).toEqual({ text: "candidate" });
  expect(result.usage).toMatchObject({ tokens: { status: "invalid" }, estimated_cost: { status: "invalid" } });
});

const reported = { usage: { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 10,
  cache_creation_input_tokens: 12 }, total_cost_usd: .25 };
it.each([0, 1])("keeps error results failed with their usage at exit %s", async exitCode => {
  const error = await response(Buffer.from(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true,
    ...reported, errors: ["private diagnostics"], session_id: "private session" })), exitCode).catch(error => error);
  expect(error).toBeInstanceOf(TaskProviderFailure);
  expect(error.code).toBe(exitCode === 0 ? "TASK_PROVIDER_RESULT_INVALID" : "TASK_PROVIDER_FAILED");
  expect(error.usage.estimated_cost).toEqual({ status: "reported", usd: .25 });
  expect(JSON.stringify(error)).not.toContain("private");
});
it.each(["error_during_execution", "error_max_budget_usd"])("marks incomplete %s telemetry explicitly", async subtype => {
  const error = await response(Buffer.from(JSON.stringify({ type: "result", subtype, is_error: true,
    ...reported, total_cost_usd: 0 })), 1).catch(error => error);
  expect(error).toBeInstanceOf(TaskProviderFailure);
  expect(error.usage.tokens).toEqual({ status: "invalid" });
  expect(error.usage.estimated_cost).toEqual(subtype === "error_during_execution"
    ? { status: "invalid" } : { status: "reported", usd: 0 });
});
it.each([
  { type: "result", subtype: "unknown_error", is_error: true },
  { type: "result", subtype: "error_max_turns", is_error: false },
  { type: "result", subtype: "success", is_error: true },
  { type: "other", subtype: "error_max_turns", is_error: true },
])("does not accept telemetry from an incoherent result $subtype", async envelope => {
  const error = await response(Buffer.from(JSON.stringify({ ...envelope, ...reported })), 1).catch(error => error);
  expect(error.code).toBe("TASK_PROVIDER_FAILED");
  expect(error).not.toBeInstanceOf(TaskProviderFailure);
});
it("preserves observed usage when a success envelope lacks required candidate output", async () => {
  const error = await response(Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    ...reported }))).catch(error => error);
  expect(error).toBeInstanceOf(TaskProviderFailure);
  expect(error.code).toBe("TASK_PROVIDER_RESULT_INVALID");
  expect(error.usage.estimated_cost).toEqual({ status: "reported", usd: .25 });
});
