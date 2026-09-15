#!/usr/bin/env bash
set -euo pipefail

if [[ "${JARVIS_PRODUCTION_ACTIVATION_APPROVAL:-}" != "approved" ]]; then
  printf 'JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED\n' >&2
  exit 2
fi

readonly WORKTREE="${1:-/home/jm/orca/projects/Orca-JARVIS}"
readonly STATE_ROOT="${JARVIS_STATE_ROOT:-/home/jm/.local/state/orca-jarvis}"
readonly RUNTIME_ROOT="${JARVIS_AUTHORITY_RUNTIME_ROOT:-${STATE_ROOT}/authority}"
readonly CONTROL_ROOT="${JARVIS_CONTROL_CENTER_RUNTIME_ROOT:-${STATE_ROOT}/control-center}"
readonly NODE_BIN="${JARVIS_NODE_BIN:-/home/jm/.nvm/versions/node/v24.19.0/bin/node}"
readonly CONTROL_VERIFIER="${CONTROL_ROOT}/release-verifier.mjs"
readonly CURRENT="${RUNTIME_ROOT}/current"

[[ -d "${WORKTREE}" && -x "${NODE_BIN}" && -f "${CONTROL_VERIFIER}" ]] || {
  printf 'AUTHORITY_RELEASE_NOT_READY\n' >&2
  exit 1
}

cd "${WORKTREE}"

dependency_release="$(readlink -f -- "${CONTROL_ROOT}/current")"
"${NODE_BIN}" "${CONTROL_VERIFIER}" --verify-release "${dependency_release}" --runtime-root "${CONTROL_ROOT}" >/dev/null
"${NODE_BIN}" "${WORKTREE}/scripts/check-release-dependency-reuse.mjs" "${WORKTREE}" "${dependency_release}" >/dev/null
npm run build

mkdir -p "${WORKTREE}/.runtime-tmp" "${WORKTREE}/.runtime-tmp/authority-sidecars"
stage="$(mktemp -d "${WORKTREE}/.runtime-tmp/authority-stage-XXXXXXXX")"
cleanup() {
  if [[ -n "${stage}" && -d "${stage}" ]]; then
    rm -rf -- "${stage}"
  fi
}
trap cleanup EXIT

cp -al -- "${dependency_release}/node_modules" "${stage}/node_modules"
for name in package.json package-lock.json dist migrations ops deploy config contracts; do
  [[ -e "${WORKTREE}/${name}" ]] && cp -a -- "${WORKTREE}/${name}" "${stage}/"
done
"${NODE_BIN}" "${WORKTREE}/scripts/check-release-dependency-reuse.mjs" "${stage}" "${stage}" >/dev/null

source_head="$(git rev-parse HEAD)"
source_tree="$(git rev-parse HEAD^{tree})"
source_parent="$(git rev-parse HEAD^ 2>/dev/null || printf '%040d' 0)"
source_subject="$(git log -1 --format=%s HEAD)"
source_timestamp="$(git show -s --format=%cI HEAD)"
source_epoch="$(git show -s --format=%ct HEAD)"
archive_digest="$(git archive HEAD | sha256sum | awk '{print $1}')"
offline_cache_digest="$(sha256sum package-lock.json | awk '{print $1}')"
build_digest="$(printf 'npm run build' | sha256sum | awk '{print $1}')"
verify_digest="$(printf 'npm run verify' | sha256sum | awk '{print $1}')"
reproducibility_receipt="$(python3 - "${WORKTREE}" "${stage}" <<'PY'
from hashlib import sha256
from pathlib import Path
import os, subprocess, sys
root, stage = map(Path, sys.argv[1:])
h = sha256(b"orca-jarvis/authority-reproducibility/v1\0")
h.update(subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"]))
h.update(subprocess.check_output(["git", "-C", str(root), "status", "--porcelain=v1", "-z"]))
for name in ["package.json", "package-lock.json", "dist", "migrations", "ops", "deploy", "config", "contracts"]:
    base = stage / name
    if not base.exists() and not base.is_symlink():
        continue
    paths = [base] if base.is_file() or base.is_symlink() else sorted(base.rglob("*"))
    for path in paths:
        rel = path.relative_to(stage).as_posix().encode()
        h.update(len(rel).to_bytes(8, "big")); h.update(rel)
        if path.is_symlink():
            value = os.readlink(path).encode()
            h.update(b"L"); h.update(len(value).to_bytes(8, "big")); h.update(value)
        elif path.is_file():
            body = path.read_bytes()
            h.update(b"F"); h.update((path.stat().st_mode & 0o7777).to_bytes(4, "big"))
            h.update(len(body).to_bytes(8, "big")); h.update(body)
print(h.hexdigest())
PY
)"

manifest_json="$("${NODE_BIN}" --input-type=module - \
  "${stage}" "${WORKTREE}/.runtime-tmp/authority-sidecars" \
  "${source_head}" "${source_tree}" "${source_parent}" "${source_subject}" "${source_timestamp}" \
  "${archive_digest}" "${source_epoch}" "${offline_cache_digest}" "${build_digest}" "${verify_digest}" \
  "${reproducibility_receipt}" <<'JS'
import { writeReleaseManifest } from "./dist/src/personal-os-release-manifest.js";
const [root, sidecarDir, commit, tree, firstParent, subject, timestamp, archiveDigest, epoch,
  offlineDigest, buildDigest, verifyDigest, reproducibilityReceipt] = process.argv.slice(2);
const result = writeReleaseManifest({
  root,
  sidecarDir,
  artifact: "jarvis-authority",
  source: {
    commit,
    tree,
    first_parent: firstParent,
    subject,
    commit_timestamp: timestamp,
    archive_digest: archiveDigest,
  },
  build: {
    source_date_epoch: Number(epoch),
    builder_command: "ops/authority/publish-verified-release.sh",
    offline_cache_digest: offlineDigest,
    lifecycle_command_digests: [buildDigest, verifyDigest],
    reproducibility_receipt: reproducibilityReceipt,
  },
});
console.log(JSON.stringify({ payload_digest: result.manifest.payload_digest, sidecar: result.sidecarPath }));
JS
)"
payload_digest="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["payload_digest"])' <<<"${manifest_json}")"
sidecar="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["sidecar"])' <<<"${manifest_json}")"
release_id="$(sha256sum "${stage}/release.manifest.json" | awk '{print substr($1,1,40)}')"
release_path="${RUNTIME_ROOT}/releases/${release_id}"
mkdir -p "${RUNTIME_ROOT}/releases" "${RUNTIME_ROOT}/receipts"
if [[ -e "${release_path}" ]]; then
  cmp -s "${stage}/release.manifest.json" "${release_path}/release.manifest.json" || {
    printf 'AUTHORITY_RELEASE_MISMATCH\n' >&2
    exit 1
  }
else
  mv -- "${stage}" "${release_path}"
  stage=""
fi

manifest_sha="$(sha256sum "${release_path}/release.manifest.json" | awk '{print $1}')"
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifest_sha256"])' "${sidecar}")" == "${manifest_sha}" ]] || {
  printf 'AUTHORITY_MANIFEST_SIDECAR_MISMATCH\n' >&2
  exit 1
}

temporary="${RUNTIME_ROOT}/.current-${release_id}-$$"
ln -s "releases/${release_id}" "${temporary}"
mv -Tf -- "${temporary}" "${CURRENT}"
[[ "$(readlink -f -- "${CURRENT}")" == "${release_path}" ]] || {
  printf 'AUTHORITY_ACTIVATION_FAILED\n' >&2
  exit 1
}

receipt="${RUNTIME_ROOT}/receipts/${release_id}.json"
python3 - "${receipt}" "${release_id}" "${source_head}" "${payload_digest}" "${manifest_sha}" "${reproducibility_receipt}" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import json, sys
path, release, source, payload, manifest, reproducibility = sys.argv[1:]
body = {
    "schema_version": 1,
    "release": release,
    "source_head": source,
    "payload_digest": payload,
    "manifest_sha256": manifest,
    "reproducibility_receipt": reproducibility,
    "activated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "verified": True,
}
Path(path).write_text(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
Path(path).chmod(0o600)
PY
printf '{"ok":true,"release":"%s","receipt":"%s"}\n' "${release_id}" "${receipt}"