import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
import { MemoryScopedWriteSpool } from "../../src/memory-scoped-write-spool.js";
import { inspectPrivateSpoolRoot, readPrivateSpoolFile } from "../../src/memory-private-spool-files.js";

const request = JSON.parse(readFileSync(new URL("../fixtures/scoped-write-request-v4.json", import.meta.url), "utf8"));
const now = new Date(request.created_at);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scoped-spool-")); roots.push(root);
  return { root, spool: new MemoryScopedWriteSpool(root, "provider:fixture") };
}
it("publishes exact bytes once and resumes through a new reader without changing inode", () => {
  const { root, spool } = fixture(); const raw = canonicalize(request);
  const published = spool.publish(raw, now); const inode = statSync(published.path).ino;
  expect(published.created).toBe(true);
  expect(new MemoryScopedWriteSpool(root, "provider:fixture").read(request.idempotency_key, now)).toEqual(request);
  expect(spool.publish(raw, now)).toEqual({ ...published, created: false });
  expect(statSync(published.path).ino).toBe(inode);
  expect(statSync(published.path).mode & 0o777).toBe(0o600);
});
it("rejects different valid request bytes under the same idempotency key without overwriting", () => {
  const { spool } = fixture(); const raw = canonicalize(request); const published = spool.publish(raw, now);
  const changed = structuredClone(request); changed.expires_at = new Date(Date.parse(changed.expires_at) - 1).toISOString();
  const base = { ...changed }; delete base.request_id; delete base.request_digest;
  changed.request_digest = memoryHash("orca-jarvis/memory-scoped-write-request/v4\0", base);
  changed.request_id = `memreq:scoped:v4:${changed.request_digest.slice(7)}`;
  expect(() => spool.publish(canonicalize(changed), now)).toThrow("SCOPED_WRITE_SPOOL_CONFLICT");
  expect(readFileSync(published.path, "utf8")).toBe(raw);
});
it("bounds reads before decoding and rejects hard links and symlinks", () => {
  const { root, spool } = fixture(); const published = spool.publish(canonicalize(request), now);
  writeFileSync(published.path, "x".repeat(32769));
  expect(() => spool.read(request.idempotency_key, now)).toThrow("MEMORY_SPOOL_FILE_INVALID");
  writeFileSync(published.path, canonicalize(request)); linkSync(published.path, join(root, "linked"));
  expect(() => spool.read(request.idempotency_key, now)).toThrow("MEMORY_SPOOL_FILE_INVALID");
  rmSync(published.path); symlinkSync(join(root, "linked"), published.path);
  expect(() => spool.read(request.idempotency_key, now)).toThrow();
});
it("rejects filename identity mismatch, expiry and root replacement", () => {
  const { root, spool } = fixture(); const published = spool.publish(canonicalize(request), now);
  const other = `memidem:scoped:v4:${"a".repeat(64)}`;
  renameSync(published.path, join(root, `${"a".repeat(64)}.v4.json`));
  expect(() => spool.read(other, now)).toThrow("SCOPED_WRITE_SPOOL_IDENTITY_INVALID");
  renameSync(join(root, `${"a".repeat(64)}.v4.json`), published.path);
  expect(() => spool.read(request.idempotency_key, new Date(request.expires_at))).toThrow("SCOPED_WRITE_REQUEST_INVALID");
  chmodSync(root, 0o755);
  expect(() => spool.read(request.idempotency_key, now)).toThrow("MEMORY_SPOOL_ROOT_CHANGED");
  expect(() => new MemoryScopedWriteSpool(root, "provider:fixture")).toThrow("MEMORY_SPOOL_ROOT_INVALID");
});
it("rejects traversal keys and invalid reader budgets", () => {
  const { root, spool } = fixture();
  expect(() => spool.read("../outside", now)).toThrow("SCOPED_WRITE_SPOOL_KEY_INVALID");
  expect(() => readPrivateSpoolFile(inspectPrivateSpoolRoot(root), join(root, "missing"), Infinity)).toThrow("MEMORY_SPOOL_LIMIT_INVALID");
});

it("does not silently normalize a UTF-8 BOM or malformed encoding", () => {
  const { spool } = fixture(); const published = spool.publish(canonicalize(request), now);
  for (const prefix of [Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xff])]) {
    writeFileSync(published.path, Buffer.concat([prefix, Buffer.from(canonicalize(request))]));
    expect(() => spool.read(request.idempotency_key, now)).toThrow();
  }
});

it("recovers only the exact hardlink left by a terminated publisher", () => {
  const { root, spool } = fixture(); const raw = canonicalize(request);
  const published = spool.publish(raw, now); const inode = statSync(published.path).ino;
  const child = spawnSync(process.execPath, ["-e", `
    const fs=require('node:fs'),crypto=require('node:crypto');
    const path=process.argv[2]+'/.scoped-write-'+process.pid+'-'+crypto.randomUUID()+'.tmp';
    fs.linkSync(process.argv[1],path);process.exit(73);
  `, published.path, root], { timeout: 5000 });
  expect(child.status).toBe(73); expect(statSync(published.path).nlink).toBe(2);
  expect(() => spool.read(request.idempotency_key, now)).toThrow("MEMORY_SPOOL_FILE_INVALID");
  expect(spool.publish(raw, now).created).toBe(false);
  expect(statSync(published.path).nlink).toBe(1); expect(statSync(published.path).ino).toBe(inode);
  expect(spool.read(request.idempotency_key, now)).toEqual(request);
});
it.each(["live", "unknown"])("preserves a %s publisher link instead of guessing ownership", mode => {
  const { root, spool } = fixture(); const raw = canonicalize(request); const published = spool.publish(raw, now);
  const temp = join(root, mode === "live" ? `.scoped-write-${process.pid}-${randomUUID()}.tmp` : "unknown.tmp");
  linkSync(published.path, temp);
  expect(() => spool.publish(raw, now)).toThrow(mode === "live" ? "MEMORY_SPOOL_PUBLISHER_ACTIVE" : "MEMORY_SPOOL_RECOVERY_UNPROVED");
  expect(statSync(temp).nlink).toBe(2); expect(readFileSync(published.path, "utf8")).toBe(raw);
});
