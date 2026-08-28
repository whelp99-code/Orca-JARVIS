import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SENTINEL = "SECOND_BRAIN_CONTRACT_MISMATCH";
const DESTINATION = resolve("contracts/second-brain-mcp-v1.json");
const DESTINATION_SIDECAR = `${DESTINATION}.sha256`;
const args = process.argv.slice(2);
const mode = args[0];
const sourceFlag = args[1];
const sourceArgument = args[2];

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write("usage: node scripts/sync-second-brain-contract.mjs {--write|--check} --source ABSOLUTE_PATH\n");
  process.exit(0);
}

function fail() {
  process.stderr.write(`${SENTINEL}\n`);
  process.exitCode = 1;
}

try {
if ((mode !== "--write" && mode !== "--check") || sourceFlag !== "--source" || sourceArgument === undefined || args.length !== 3) {
  fail();
} else {
  const source = resolve(sourceArgument);
  const sidecar = `${source}.sha256`;
  const sourceIsSafe = sourceArgument === source
    && basename(source) === "second-brain-mcp-v1.json"
    && existsSync(source) && existsSync(sidecar)
    && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink()
    && lstatSync(sidecar).isFile() && !lstatSync(sidecar).isSymbolicLink()
    && realpathSync(source) === source && realpathSync(sidecar) === sidecar;
  if (!sourceIsSafe) {
    fail();
  } else {
    const payload = readFileSync(source);
    const digest = createHash("sha256").update(payload).digest("hex");
    const expectedSidecar = `${digest}\n`;
    const sourceDigestValid = /^[0-9a-f]{64}\n$/.test(readFileSync(sidecar, "ascii"))
      && readFileSync(sidecar, "ascii") === expectedSidecar;
    if (!sourceDigestValid) {
      fail();
    } else if (mode === "--check") {
      if (!existsSync(DESTINATION) || !existsSync(DESTINATION_SIDECAR)
        || !readFileSync(DESTINATION).equals(payload)
        || readFileSync(DESTINATION_SIDECAR, "ascii") !== expectedSidecar) fail();
      else process.stdout.write(`${digest}\n`);
    } else {
      const dirty = (existsSync(DESTINATION) || existsSync(DESTINATION_SIDECAR))
        && spawnSync("git", ["status", "--porcelain", "--", DESTINATION, DESTINATION_SIDECAR], { encoding: "utf8" }).stdout.trim() !== "";
      if (dirty) {
        fail();
      } else {
        const temporary = `${DESTINATION}.${process.pid}.tmp`;
        const sidecarTemporary = `${DESTINATION_SIDECAR}.${process.pid}.tmp`;
        const cleanup = () => {
          rmSync(temporary, { force: true });
          rmSync(sidecarTemporary, { force: true });
        };
        process.once("SIGINT", () => { cleanup(); process.exit(130); });
        try {
          mkdirSync(resolve("contracts"), { recursive: true });
          writeFileSync(temporary, payload, { mode: 0o644 });
          writeFileSync(sidecarTemporary, expectedSidecar, { encoding: "ascii", mode: 0o644 });
          renameSync(temporary, DESTINATION);
          renameSync(sidecarTemporary, DESTINATION_SIDECAR);
          process.stdout.write(`${digest}\n`);
        } finally {
          cleanup();
        }
      }
    }
  }
}
} catch {
  fail();
}
