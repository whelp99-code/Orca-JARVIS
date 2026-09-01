import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseManifest, MANIFEST_NAME, writeReleaseManifest } from "../../src/personal-os-release-manifest.js";
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
