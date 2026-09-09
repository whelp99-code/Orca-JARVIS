#!/usr/bin/env node
// Read-only preflight for reusing a sealed release's existing node_modules.
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
function fail(code) { throw new Error(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
try {
  const [workspace, release] = process.argv.slice(2);
  if (process.argv.length !== 4 || !isAbsolute(workspace) || !isAbsolute(release)) fail('RELEASE_DEPENDENCY_INPUT_INVALID');
  const expected = readFileSync(join(workspace, 'package-lock.json'));
  const candidate = readFileSync(join(release, 'package-lock.json'));
  if (!expected.equals(candidate)) fail('RELEASE_DEPENDENCY_LOCK_MISMATCH');
  const lock = JSON.parse(expected.toString('utf8'));
  const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
  if (!object(manifest) || !object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages)
    || !object(lock.packages['']) || !isDeepStrictEqual(manifest.dependencies ?? {}, lock.packages[''].dependencies ?? {}))
    fail('RELEASE_DEPENDENCY_MANIFEST_MISMATCH');
  const dependencies = manifest.dependencies ?? {};
  if (!object(dependencies)) fail('RELEASE_DEPENDENCY_MANIFEST_MISMATCH');
  for (const name of Object.keys(dependencies)) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) fail('RELEASE_DEPENDENCY_MANIFEST_MISMATCH');
    const entry = lock.packages[`node_modules/${name}`];
    try {
      const installed = JSON.parse(readFileSync(join(release, 'node_modules', name, 'package.json'), 'utf8'));
      if (!object(entry) || typeof entry.version !== 'string' || !object(installed) || installed.version !== entry.version)
        fail('RELEASE_DEPENDENCY_TREE_MISMATCH');
    } catch { fail('RELEASE_DEPENDENCY_TREE_MISMATCH'); }
  }
  console.log(JSON.stringify({ ok: true, lock_sha256: createHash('sha256').update(expected).digest('hex'),
    direct_runtime_dependencies: Object.keys(dependencies).length,
    scope: 'exact lock reuse and direct runtime versions; sealed contents, transitive closure and native ABI require release gates' }));
} catch (error) {
  const code = error instanceof Error && /^RELEASE_DEPENDENCY_[A-Z_]+$/.test(error.message)
    ? error.message : 'RELEASE_DEPENDENCY_INPUT_INVALID';
  process.stderr.write(code + '\n'); process.exitCode = 2;
}
