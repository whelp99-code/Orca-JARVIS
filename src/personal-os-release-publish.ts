import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";

const SHA = /^[0-9a-f]{40}$/;

export type PublishInput = {
  readonly stage: string;
  readonly runtimeRoot: string;
  readonly sha: string;
};

export type PublishResult = {
  readonly sha: string;
  readonly release: string;
  readonly currentTarget: string;
};

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function publishRelease(input: PublishInput): PublishResult {
  if (!SHA.test(input.sha)) throw new PersonalOsError("E_SHA_INVALID");
  const stage = assertIsolatedRoot(input.stage);
  const runtimeRoot = assertIsolatedRoot(input.runtimeRoot);
  if (!existsSync(stage) || !lstatSync(stage).isDirectory()) throw new PersonalOsError("E_STAGE_INVALID");
  mkdirSync(join(runtimeRoot, "releases"), { recursive: true });
  fsyncDir(runtimeRoot);
  const release = join(runtimeRoot, "releases", input.sha);
  if (existsSync(release)) throw new PersonalOsError("E_RELEASE_MISMATCH");
  mkdirSync(dirname(release), { recursive: true });
  renameSync(stage, release);
  fsyncPath(release);
  fsyncDir(join(runtimeRoot, "releases"));
  const currentTarget = `releases/${input.sha}`;
  const temporary = join(runtimeRoot, `.current-${input.sha}`);
  rmSync(temporary, { force: true });
  symlinkSync(currentTarget, temporary);
  fsyncDir(runtimeRoot);
  renameSync(temporary, join(runtimeRoot, "current"));
  fsyncDir(runtimeRoot);
  return { sha: input.sha, release, currentTarget };
}
