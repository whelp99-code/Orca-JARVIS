import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/publish-control-center-release.mjs");
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REQUIRED = ["package.json", "package-lock.json", "dist/src/dashboard/server.js", "dist/dashboard/index.html"] as const;

const workspaces: string[] = [];

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; stage: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), "jcc-release-"));
  workspaces.push(root);
  return { root, stage: join(root, "stage"), runtime: join(root, "runtime") };
}

function writeRelease(root: string, marker: string): string {
  mkdirSync(join(root, "dist/src/dashboard"), { recursive: true });
  mkdirSync(join(root, "dist/dashboard"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"orca-jarvis-shadow"}\n');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, "dist/src/dashboard/server.js"), `export const marker = ${JSON.stringify(marker)};\n`);
  writeFileSync(join(root, "dist/dashboard/index.html"), `<!doctype html><title>${marker}</title>\n`);
  return root;
}

function publish(stage: string, runtime: string, sha: string) {
  return spawnSync(process.execPath, [SCRIPT, "--stage", stage, "--runtime-root", runtime, "--sha", sha], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function currentTarget(runtime: string): string | null {
  try {
    return readlinkSync(join(runtime, "current"));
  } catch {
    return null;
  }
}

function leftovers(runtime: string): string[] {
  if (!existsSync(runtime)) return [];
  return readdirSync(runtime).filter((name) => name.startsWith(".current")).sort();
}

function markerAt(runtime: string, sha: string): string {
  return readFileSync(join(runtime, "releases", sha, "dist/dashboard/index.html"), "utf8");
}

describe("control-center release publisher", () => {
  it("is a focused script that never shells out to git or npm", () => {
    expect(existsSync(SCRIPT), `missing ${SCRIPT}`).toBe(true);
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/child_process|execFile|spawn|npm |git /);
    expect(source).not.toMatch(/setTimeout|setInterval|Math\.random|Date\.now|randomUUID/);
  });

  it("rejects invalid SHA, missing dist, and mismatched existing release without moving current", () => {
    expect(existsSync(SCRIPT), `missing ${SCRIPT}`).toBe(true);
    const { stage, runtime } = workspace();
    writeRelease(stage, "keep");
    mkdirSync(join(runtime, "releases", SHA_A), { recursive: true });
    writeRelease(join(runtime, "releases", SHA_A), "keep");
    symlinkSync(join("releases", SHA_A), join(runtime, "current"));
    const before = { target: currentTarget(runtime), marker: markerAt(runtime, SHA_A) };

    const invalidSha = publish(stage, runtime, "not-a-sha");
    expect(invalidSha.status).toBe(2);
    expect(invalidSha.stderr).toContain("E_SHA_INVALID");

    const incomplete = join(stage, "..", "incomplete");
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(incomplete, "package.json"), "{}\n");
    const missingDist = publish(incomplete, runtime, SHA_B);
    expect(missingDist.status).toBe(2);
    expect(missingDist.stderr).toMatch(/E_STAGE_INVALID|E_RELEASE_MISSING/);
    for (const file of REQUIRED.slice(2)) expect(existsSync(join(incomplete, file))).toBe(false);

    writeRelease(stage, "changed");
    const mismatch = publish(stage, runtime, SHA_A);
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain("E_RELEASE_MISMATCH");

    expect({
      target: currentTarget(runtime),
      marker: markerAt(runtime, SHA_A),
      leftovers: leftovers(runtime),
      extra: existsSync(join(runtime, "releases", SHA_B)),
    }).toEqual({ target: before.target, marker: before.marker, leftovers: [], extra: false });
  });

  it("publishes an immutable relative current symlink and keeps prior releases rollback-ready", () => {
    expect(existsSync(SCRIPT), `missing ${SCRIPT}`).toBe(true);
    const { root, stage, runtime } = workspace();
    writeRelease(stage, "alpha");
    const first = publish(stage, runtime, SHA_A);
    expect({ status: first.status, stderr: first.stderr, leftovers: leftovers(runtime) }).toEqual({
      status: 0,
      stderr: "",
      leftovers: [],
    });
    expect(existsSync(stage)).toBe(false);
    expect(lstatSync(join(runtime, "current")).isSymbolicLink()).toBe(true);
    expect(currentTarget(runtime)).toBe(join("releases", SHA_A));
    expect(markerAt(runtime, SHA_A)).toContain("alpha");

    const againStage = writeRelease(join(root, "stage-a"), "alpha");
    const again = publish(againStage, runtime, SHA_A);
    expect({ status: again.status, stderr: again.stderr, target: currentTarget(runtime), leftovers: leftovers(runtime) }).toEqual({
      status: 0,
      stderr: "",
      target: join("releases", SHA_A),
      leftovers: [],
    });
    expect(existsSync(againStage)).toBe(true);

    const stageB = writeRelease(join(root, "stage-b"), "beta");
    const second = publish(stageB, runtime, SHA_B);
    expect({ status: second.status, target: currentTarget(runtime), leftovers: leftovers(runtime) }).toEqual({
      status: 0,
      target: join("releases", SHA_B),
      leftovers: [],
    });
    expect(markerAt(runtime, SHA_A)).toContain("alpha");
    expect(markerAt(runtime, SHA_B)).toContain("beta");

    const rollback = join(runtime, `.current-${SHA_A}`);
    symlinkSync(join("releases", SHA_A), rollback);
    renameSync(rollback, join(runtime, "current"));
    expect(currentTarget(runtime)).toBe(join("releases", SHA_A));
    expect(existsSync(join(runtime, "releases", SHA_B))).toBe(true);
    expect(leftovers(runtime)).toEqual([]);
  });
});
