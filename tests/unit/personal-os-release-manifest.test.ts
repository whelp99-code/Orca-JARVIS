import { chmodSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseManifest, MANIFEST_NAME, runtimeDependencyIdentity,
  writeReleaseManifest } from "../../src/personal-os-release-manifest.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const SOURCE = {
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  first_parent: "cccccccccccccccccccccccccccccccccccccccc",
  subject: "docs(operations): prove personal OS release and recovery",
  commit_timestamp: "2026-08-27T00:00:00.000Z",
  archive_digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
} as const;

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

function stage(): string {
  const root = personalOsScratch();
  scratchRoots.push(root);
  mkdirSync(join(root, "dist/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"orca-jarvis-shadow"}\n');
  writeFileSync(join(root, "dist/src/cli.js"), "export {};\n");
  return root;
}

describe("personal-OS release manifest", () => {
  it("identifies dependency bytes, modes, symlink targets and manifest-named files without exclusions", () => {
    const root = stage();
    mkdirSync(join(root, ".bin"));
    symlinkSync("../dist/src/cli.js", join(root, ".bin/tool"));
    const original = runtimeDependencyIdentity(root);
    expect(runtimeDependencyIdentity(root)).toEqual(original);
    writeFileSync(join(root, "dist/src", MANIFEST_NAME), "first");
    const withManifest = runtimeDependencyIdentity(root);
    expect(withManifest.digest).not.toBe(original.digest);
    writeFileSync(join(root, "dist/src", MANIFEST_NAME), "other");
    const withChangedManifest = runtimeDependencyIdentity(root);
    expect(withChangedManifest.digest).not.toBe(withManifest.digest);
    chmodSync(join(root, "dist/src/cli.js"), 0o700);
    const executable = runtimeDependencyIdentity(root);
    expect(executable.digest).not.toBe(withChangedManifest.digest);
    unlinkSync(join(root, ".bin/tool"));
    symlinkSync("../package.json", join(root, ".bin/tool"));
    const retargeted = runtimeDependencyIdentity(root);
    expect(retargeted.digest).not.toBe(executable.digest);
    writeFileSync(join(root, "dist/src/cli.js"), "export const changed = true;\n");
    expect(runtimeDependencyIdentity(root).digest).not.toBe(retargeted.digest);
  });

  it("rejects an escaping dependency link or a symlink used as the dependency root", () => {
    const root = stage();
    symlinkSync("..", join(root, "escape"));
    expect(() => runtimeDependencyIdentity(root)).toThrow("E_UNSAFE_SYMLINK");
    unlinkSync(join(root, "escape"));
    symlinkSync("dist", join(root, "linked-root"));
    expect(() => runtimeDependencyIdentity(join(root, "linked-root"))).toThrow("E_STAGE_INVALID");
  });

  it("includes nested manifest names in the payload and rejects a symlink self-exclusion", () => {
    const root = stage();
    const input = {
      root, artifact: "jarvis-authority" as const, source: SOURCE,
      build: { source_date_epoch: 0, builder_command: "test", offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: [], reproducibility_receipt: "g".repeat(64) },
    };
    const nested = join(root, "dist", MANIFEST_NAME);
    writeFileSync(nested, "first");
    const before = buildReleaseManifest(input);
    expect(before.entries.some(entry => entry.path === `dist/${MANIFEST_NAME}`)).toBe(true);
    writeFileSync(nested, "changed");
    expect(buildReleaseManifest(input).payload_digest).not.toBe(before.payload_digest);
    symlinkSync("package.json", join(root, MANIFEST_NAME));
    expect(() => writeReleaseManifest({ ...input, sidecarDir: join(root, "sidecar") })).toThrow(PersonalOsError);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe('{"name":"orca-jarvis-shadow"}\n');
  });

  it("hashes every payload file except the manifest itself when building a jarvis-authority artifact", () => {
    // Given
    const root = stage();
    writeFileSync(join(root, MANIFEST_NAME), "{}\n");

    // When
    const manifest = buildReleaseManifest({
      root,
      artifact: "jarvis-authority",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
    });

    // Then
    expect(manifest.self_exclusion).toEqual({ path: MANIFEST_NAME, count: 1 });
    expect(manifest.entries.some((entry) => entry.path === MANIFEST_NAME)).toBe(false);
    expect(manifest.entry_count).toBe(manifest.entries.length);
    expect(manifest.artifact).toBe("jarvis-authority");
    expect(manifest.payload_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an escaping symlink and a production runtime root", () => {
    // Given
    const root = stage();
    symlinkSync("/etc/passwd", join(root, "escape"));

    // When / Then
    expect(() => buildReleaseManifest({
      root,
      artifact: "jarvis-authority",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
    })).toThrow(PersonalOsError);

    expect(() => buildReleaseManifest({
      root: "/home/jm/.local/state/orca-jarvis/authority",
      artifact: "jarvis-authority",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
    })).toThrow(PersonalOsError);
  });

  it("seals a relative symlink that remains inside the release root", () => {
    const root = stage();
    symlinkSync("dist/src/cli.js", join(root, "cli-link"));

    const manifest = buildReleaseManifest({
      root,
      artifact: "jarvis-authority",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
    });

    expect(manifest.entries).toContainEqual(expect.objectContaining({
      path: "cli-link", type: "symlink", target: "dist/src/cli.js", sha256: null,
    }));
  });

  it("writes a sidecar that hashes the manifest bytes and keeps payload identity stable", () => {
    // Given
    const root = stage();

    // When
    const first = writeReleaseManifest({
      root,
      artifact: "second-brain-provider",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
      sidecarDir: join(root, "..", "manifests"),
    });
    const second = buildReleaseManifest({
      root,
      artifact: "second-brain-provider",
      source: SOURCE,
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: "g".repeat(64),
      },
    });

    // Then
    const sidecar = JSON.parse(readFileSync(first.sidecarPath, "utf8")) as { readonly manifest_sha256: string };
    expect(sidecar.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.payload_digest).toBe(first.manifest.payload_digest);
    expect(second.artifact).toBe("second-brain-provider");
  });
});
