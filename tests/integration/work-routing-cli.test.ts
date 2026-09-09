import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";

const roots: string[] = [];
function input() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-routing-")); roots.push(root);
  const request = join(root, "request.json");
  writeFileSync(request, JSON.stringify({ schema_version: 1, objective: "메일 회신 초안" }));
  return { root, request, policy: resolve("config/work-routing.preview.json") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("runs the compiled CLI without a database, agent or state directory", () => {
  const { root, request, policy } = input();
  const result = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "routing", "classify", request, policy], {
    cwd: root, encoding: "utf8", env: { ...process.env, JARVIS_DB: join(root, "authority.sqlite") }, timeout: 10000,
  });
  expect(JSON.parse(result)).toMatchObject({ ok: true, command: "routing.classify",
    routing: { status: "classified", executable: false, readiness: "not_probed" } });
  expect(readdirSync(root)).toEqual(["request.json"]);
});

it("rejects database or execution flags before opening the requested path", async () => {
  const { request, policy } = input();
  for (const flags of [["--db", "/nonexistent/database.sqlite"], ["--once"], ["--execute"]]) {
    await expect(execute(["routing", "classify", request, policy, ...flags])).rejects.toMatchObject({
      code: flags[0] === "--execute" ? "CLI_ARGUMENT_INVALID" : "WORK_ROUTING_INPUT_INVALID",
    });
  }
});

it("rejects symlink, FIFO, malformed UTF-8 and oversized input files", async () => {
  const { root, request, policy } = input();
  const link = join(root, "link.json"), fifo = join(root, "input.fifo");
  symlinkSync(request, link); execFileSync("mkfifo", [fifo]);
  for (const path of [link, fifo]) await expect(execute(["routing", "classify", path, policy]))
    .rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  for (const contents of [Buffer.from([0xff]), Buffer.alloc(8193, 0x20)]) {
    writeFileSync(request, contents);
    await expect(execute(["routing", "classify", request, policy])).rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  }
});
