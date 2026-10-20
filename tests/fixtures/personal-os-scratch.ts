import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedRoots } from "../../src/personal-os-protected-paths.js";
import { PROVIDER_SOURCE_COMMIT } from "../../src/personal-os-rehearsal-contract.js";
import { type RehearsalDependencies } from "../../src/personal-os-rehearsal.js";

export function personalOsRehearsalProviderSource(deployment: string): string {
  const source = join(deployment, "provider-source");
  const options = {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    encoding: "utf8" as const,
  };
  execFileSync("git", ["clone", "--quiet", join(process.cwd(), "vendor/task30-provider.bundle"), source], options);
  execFileSync("git", ["-C", source, "checkout", "--quiet", "--detach", PROVIDER_SOURCE_COMMIT], options);
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], options).trim();
  if (head !== PROVIDER_SOURCE_COMMIT) throw new Error("REHEARSAL_TEST_PROVIDER_PIN_MISMATCH");
  return source;
}

export function personalOsRehearsalDependencies(deployment: string): RehearsalDependencies {
  const namedState = join(deployment, "named-state");
  const liveUnitPath = join(deployment, "units/jm-jarvis.service");
  const environment = {
    JARVIS_STATE_ROOT: join(deployment, "authority"),
    JARVIS_PROVIDER_STATE_ROOT: join(deployment, "provider-state"),
    JARVIS_PROVIDER_SHARE_ROOT: join(deployment, "provider-share"),
    JARVIS_SHARE_ROOT: join(deployment, "authority-share"),
    JARVIS_CONFIG_ROOT: join(deployment, "config"),
    JARVIS_PROVIDER_CONFIG: join(deployment, "provider-config/config.toml"),
  };
  for (const path of [...protectedRoots(environment), namedState]) mkdirSync(path, { recursive: true });
  mkdirSync(join(deployment, "units"));
  writeFileSync(liveUnitPath, "[Service]\nExecStart=/synthetic/current/jarvis\n");
  return { environment, namedRoots: [namedState, liveUnitPath], liveUnitPath };
}

export function personalOsScratch(prefix = "jarvis-task36-"): string {
  const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function removeScratch(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
