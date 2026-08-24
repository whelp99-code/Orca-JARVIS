import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMIT = "cbc796a789c8398f04c26ef9153ba1401d2907af";
const RIGHTS = "BeyondWorks/Yoogeon Kim";
const VERIFY = "scripts/verify-third-party-permission.mjs";
const IMPORT = "scripts/import-authorized-source.mjs";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-third-party-"));
}

function fixture(overrides: {
  readonly issuer?: string;
  readonly signer?: string;
  readonly delegation_chain?: readonly string[];
  readonly expires_at?: string;
  readonly commit?: string;
  readonly path_patterns?: readonly string[];
  readonly allowed_actions?: readonly string[];
} = {}) {
  const artifact = "consent-bytes";
  const record = {
    schema_version: 1,
    artifact_sha256: sha256(artifact),
    issuer: overrides.issuer ?? RIGHTS,
    signer: overrides.signer ?? RIGHTS,
    authority_basis: "written_consent",
    delegation_chain: [...(overrides.delegation_chain ?? [RIGHTS])],
    grantee: "JARVIS",
    covered: {
      repository: "beyondworks/argo",
      commit: overrides.commit ?? COMMIT,
      path_patterns: [...(overrides.path_patterns ?? ["src/memory.mjs"])],
    },
    allowed_actions: [...(overrides.allowed_actions ?? ["copy", "modify", "derive", "internal_use"])],
    attribution: "Copyright BeyondWorks",
    expires_at: overrides.expires_at ?? "2099-01-01T00:00:00.000Z",
    verifier: "fixture",
    verified_at: "2026-08-23T00:00:00.000Z",
  };
  return { artifact, record };
}

function writeGrant(dir: string, record: object, artifact: string): { artifactPath: string; permissionPath: string } {
  const artifactPath = join(dir, "permission.artifact");
  const permissionPath = join(dir, "PERMISSION.json");
  writeFileSync(artifactPath, artifact);
  writeFileSync(permissionPath, `${JSON.stringify(record)}\n`);
  return { artifactPath, permissionPath };
}

function runImport(options: {
  readonly cwd: string;
  readonly permissionPath: string;
  readonly artifactPath: string;
  readonly sourceRoot: string;
  readonly relativePath: string;
  readonly destination: string;
  readonly provenancePath: string;
  readonly action?: string;
  readonly commit?: string;
}) {
  return spawnSync(process.execPath, [
    IMPORT,
    "--path", options.relativePath,
    "--dest", options.destination,
    "--source-root", options.sourceRoot,
    "--provenance", options.provenancePath,
    "--action", options.action ?? "copy",
    ...(options.commit ? ["--commit", options.commit] : []),
  ], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      JARVIS_ARGO_PERMISSION_PATH: options.artifactPath,
      JARVIS_ARGO_PERMISSION_JSON: options.permissionPath,
    },
  });
}

describe("third-party provenance", () => {
  it("imports a covered file and records grant-bound provenance", () => {
    const root = tempDir();
    const sourceRoot = join(root, "argo");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src/memory.mjs"), "export const memory = true;\n");
    const { artifact, record } = fixture();
    const grant = writeGrant(root, record, artifact);
    const destination = join(root, "imported/memory.mjs");
    const provenancePath = join(root, "PROVENANCE.jsonl");
    const result = runImport({
      cwd: process.cwd(),
      permissionPath: grant.permissionPath,
      artifactPath: grant.artifactPath,
      sourceRoot,
      relativePath: "src/memory.mjs",
      destination,
      provenancePath,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(destination, "utf8")).toBe("export const memory = true;\n");
    const row = JSON.parse(readFileSync(provenancePath, "utf8").trim()) as {
      origin: string;
      source_sha256: string;
      destination_sha256: string;
      notice: string;
      grant_commit: string;
    };
    expect(row).toMatchObject({
      origin: "copied",
      source_sha256: sha256("export const memory = true;\n"),
      destination_sha256: sha256("export const memory = true;\n"),
      notice: "Copyright BeyondWorks",
      grant_commit: COMMIT,
    });
  });

  it("refuses the seven fail-closed grant cases and writes no output", () => {
    const repo = process.cwd();
    const root = tempDir();
    const sourceRoot = join(root, "argo");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src/memory.mjs"), "export const memory = true;\n");
    writeFileSync(join(sourceRoot, "src/billing.mjs"), "export const billing = true;\n");
    const { artifact, record } = fixture();
    const cases = [
      { name: "missing artifact", grant: fixture(), artifactPath: join(root, "missing.artifact"), relativePath: "src/memory.mjs", action: "copy", code: "THIRD_PARTY_ARTIFACT_MISSING" },
      { name: "Kim Hyo-yul without delegation", grant: fixture({ issuer: "Kim Hyo-yul", signer: "Kim Hyo-yul", delegation_chain: [] }), relativePath: "src/memory.mjs", action: "copy", code: "THIRD_PARTY_DELEGATION_MISSING" },
      { name: "signer mismatch", grant: fixture({ issuer: "Unknown Co", signer: "Unknown Co", delegation_chain: [] }), relativePath: "src/memory.mjs", action: "copy", code: "THIRD_PARTY_SIGNER_MISMATCH" },
      { name: "expired grant", grant: fixture({ expires_at: "2020-01-01T00:00:00.000Z" }), relativePath: "src/memory.mjs", action: "copy", code: "THIRD_PARTY_GRANT_EXPIRED" },
      { name: "wrong commit", grant: fixture({ commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), relativePath: "src/memory.mjs", action: "copy", code: "THIRD_PARTY_COMMIT_MISMATCH" },
      { name: "wrong path", grant: fixture(), relativePath: "src/billing.mjs", action: "copy", code: "THIRD_PARTY_PATH_NOT_COVERED" },
      { name: "ungranted action", grant: fixture(), relativePath: "src/memory.mjs", action: "redistribute", code: "THIRD_PARTY_ACTION_NOT_GRANTED" },
    ] as const;
    const denials = cases.map(entry => {
      const dir = join(root, entry.name.replaceAll(" ", "-"));
      mkdirSync(dir, { recursive: true });
      const grant = writeGrant(dir, entry.grant.record, entry.grant.artifact);
      const destination = join(dir, "out.mjs");
      const provenancePath = join(dir, "PROVENANCE.jsonl");
      const result = runImport({
        cwd: repo,
        permissionPath: grant.permissionPath,
        artifactPath: "artifactPath" in entry ? entry.artifactPath : grant.artifactPath,
        sourceRoot,
        relativePath: entry.relativePath,
        destination,
        provenancePath,
        action: entry.action,
      });
      const stderr = `${result.stdout}\n${result.stderr}`;
      const parsed = stderr.match(/"code":"([^"]+)"/);
      return {
        name: entry.name,
        code: parsed?.[1] ?? `exit:${result.status}`,
        wrote: existsSync(destination) || existsSync(provenancePath),
      };
    });
    expect(denials.map(item => item.code)).toEqual(cases.map(item => item.code));
    expect(denials.every(item => item.wrote === false)).toBe(true);
    mkdirSync(join(repo, ".omo/evidence/integration/03"), { recursive: true });
    writeFileSync(join(repo, ".omo/evidence/integration/03/denials.json"), `${JSON.stringify({ denials }, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
  });

  it("labels a clean-room module as independent with no copied-source hash", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { independentProvenance } from './scripts/verify-third-party-permission.mjs'; process.stdout.write(JSON.stringify(independentProvenance('src/runtime-home.ts')));"], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ origin: "independent", source_path: "src/runtime-home.ts", source_sha256: null });
  });

  it("runs the verify CLI against a generated fixture", () => {
    const root = tempDir();
    const { artifact, record } = fixture();
    const grant = writeGrant(root, record, artifact);
    const result = spawnSync(process.execPath, [VERIFY], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        JARVIS_ARGO_PERMISSION_PATH: grant.artifactPath,
        JARVIS_ARGO_PERMISSION_JSON: grant.permissionPath,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(record.artifact_sha256);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/03"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/03/permission.json"), result.stdout);
  });
});
