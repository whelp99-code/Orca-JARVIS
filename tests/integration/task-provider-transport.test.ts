import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeTaskCandidateProvider } from "../../src/claude-task-provider.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function response(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-provider-transport-")); roots.push(root);
  const path = join(root, "provider");
  await writeFile(path, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => {
    process.stdout.write(Buffer.from('${bytes.toString("base64")}', 'base64'));
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
