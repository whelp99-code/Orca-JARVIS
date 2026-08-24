#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importAuthorizedSource, loadJson, REFUSALS } from "./verify-third-party-permission.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

try {
  const relativePath = arg("--path");
  const destination = arg("--dest");
  const sourceRoot = arg("--source-root");
  const action = arg("--action") ?? "copy";
  if (!relativePath || !destination || !sourceRoot) throw Object.assign(new Error(REFUSALS.PATH_NOT_COVERED), { code: REFUSALS.PATH_NOT_COVERED });
  const permission = loadJson(process.env.JARVIS_ARGO_PERMISSION_JSON ?? join(root, "third_party/argo/PERMISSION.json"));
  const lock = loadJson(join(root, "third_party/sources.lock.json"));
  const row = importAuthorizedSource({
    permission,
    lock,
    artifactPath: process.env.JARVIS_ARGO_PERMISSION_PATH,
    sourceRoot,
    relativePath,
    destinationPath: destination,
    provenancePath: arg("--provenance") ?? join(root, "third_party/argo/PROVENANCE.jsonl"),
    commit: arg("--commit"),
    action,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, provenance: row })}\n`);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : REFUSALS.PERMISSION_INVALID;
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
  process.exitCode = 2;
}
