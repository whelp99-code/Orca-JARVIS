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
  expect(await response(bytes)).toEqual({ output: { text: content }, output_bytes: bytes.length });
});
