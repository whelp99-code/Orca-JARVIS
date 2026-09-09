# Isolated runtime packaging

2026-09-09. Backlog19: turn the complete runtime experiment into a repeatable
developer command. Fixture release rehearsal remains a separate mechanism test.

The packager builds from the current checkout, captures existing backend source
and artifact identities, copies explicit runtime roots into a fresh directory,
installs locked production dependencies from the local npm cache, and runs the
existing CLI smoke against isolated state. It checks input identity again after
packaging. Failed output directories remain for diagnosis without a success receipt.

The command never publishes a release or changes current. Output always records
deployment_ready=false: dashboard/browser/provider gates, sealed release manifests
and reproducibility validation remain separate. Source dirtiness is reported rather
than relabeled as a clean release. Native dependencies are validated on this host;
the resulting directory is not asserted portable to another ABI/platform.

Use a fresh child of an explicit scratch parent. Explicit copied roots exclude the
backend build lock/staging directories. Existing fileIdentity rejects symlinks and
special files in copied input and bounds file counts/bytes. npm's generated runtime
dependency tree retains normal package symlinks. Dependency logs stay in the scratch
directory; the final receipt contains identities and exit evidence, not log contents.

The CLI smoke harness is now an explicit copied and hashed payload root. Execute
that packaged copy during packaging and permit the same entrypoint for independent
revalidation. It imports only Node builtins and invokes the package's own CLI, so
the source checkout is unnecessary after artifact creation. This closes the former
source-harness dependency without copying the entire developer script tree.

Installed dependencies must also have an observed identity: hash all files, modes,
directories and relative symlink targets under node_modules after npm ci, then
compare again after smoke and runtime identity checks. Reuse the release manifest
walker, but exclude no filenames for dependencies (including release.manifest.json).
Use a distinct digest domain; existing release manifest bytes and exclusions remain
unchanged. Record this separate identity in the package receipt. This is a local
snapshot, not a signature, reproducible build proof, or production activation gate.
