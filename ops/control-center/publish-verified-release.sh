#!/usr/bin/env bash
set -euo pipefail

if [[ "${JARVIS_PRODUCTION_ACTIVATION_APPROVAL:-}" != "approved" ]]; then
  printf 'JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED\n' >&2
  exit 2
fi

readonly WORKTREE="${1:-/home/jm/orca/projects/Orca-JARVIS}"
readonly STATE_ROOT="${JARVIS_STATE_ROOT:-/home/jm/.local/state/orca-jarvis}"
readonly RUNTIME_ROOT="${JARVIS_CONTROL_CENTER_RUNTIME_ROOT:-${STATE_ROOT}/control-center}"
readonly NODE_BIN="${JARVIS_NODE_BIN:-/home/jm/.nvm/versions/node/v24.19.0/bin/node}"
readonly VERIFIER="${RUNTIME_ROOT}/release-verifier.mjs"
readonly NATIVE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
readonly CURRENT="${RUNTIME_ROOT}/current"

[[ -d "${WORKTREE}" && -x "${NODE_BIN}" && -f "${VERIFIER}" && -L "${CURRENT}" ]] || {
  printf 'CONTROL_CENTER_RELEASE_NOT_READY\n' >&2
  exit 1
}

cd "${WORKTREE}"

dependency_release="$(readlink -f -- "${CURRENT}")"
[[ "$(dirname -- "${dependency_release}")" == "$(readlink -f -- "${RUNTIME_ROOT}/releases")" ]] || {
  printf 'CONTROL_CENTER_CURRENT_INVALID\n' >&2
  exit 1
}

"${NODE_BIN}" "${WORKTREE}/scripts/check-release-dependency-reuse.mjs" "${WORKTREE}" "${dependency_release}" >/dev/null
npm run build

stage="$(mktemp -d "${RUNTIME_ROOT}/.stage-control-center-XXXXXXXX")"
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
if [[ -f "${WORKTREE}/scripts/dashboard-authority-fingerprint.mjs" ]]; then
  mkdir -p "${stage}/scripts"
  cp -a -- "${WORKTREE}/scripts/dashboard-authority-fingerprint.mjs" "${stage}/scripts/"
fi

native_sha="sha256:$(sha256sum "${stage}/${NATIVE}" | awk '{print $1}')"
"${NODE_BIN}" "${VERIFIER}" --stage "${stage}" --normalize-native-build \
  --native-path "${NATIVE}" --native-sha256 "${native_sha}" >/dev/null
"${NODE_BIN}" "${VERIFIER}" --stage "${stage}" --write-source-manifest >/dev/null

source_head="$(git rev-parse HEAD)"
dirty_baseline_digest="$(python3 - "${WORKTREE}" "${stage}/source-manifest.json" <<'PY'
from hashlib import sha256
from pathlib import Path
import subprocess, sys
root, manifest = sys.argv[1:]
h = sha256(b"orca-jarvis/control-center-dirty-baseline/v1\0")
h.update(subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"]))
h.update(subprocess.check_output(["git", "-C", root, "status", "--porcelain=v1", "-z"]))
h.update(Path(manifest).read_bytes())
print("sha256:" + h.hexdigest())
PY
)"

"${NODE_BIN}" "${VERIFIER}" --stage "${stage}" --write-artifact-manifest \
  --source-head "${source_head}" --dirty-baseline-digest "${dirty_baseline_digest}" >/dev/null
publish_json="$("${NODE_BIN}" "${VERIFIER}" --stage "${stage}" --runtime-root "${RUNTIME_ROOT}" --publish-artifact)"
release="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["release"])' <<<"${publish_json}")"
stage=""
release_path="${RUNTIME_ROOT}/releases/${release}"
"${NODE_BIN}" "${VERIFIER}" --verify-release "${release_path}" --runtime-root "${RUNTIME_ROOT}" >/dev/null
"${NODE_BIN}" "${VERIFIER}" --activate-release "${release_path}" --runtime-root "${RUNTIME_ROOT}" >/dev/null
"${NODE_BIN}" "${VERIFIER}" --verify-release "$(readlink -f -- "${CURRENT}")" --runtime-root "${RUNTIME_ROOT}" >/dev/null

mkdir -p "${RUNTIME_ROOT}/receipts"
receipt="${RUNTIME_ROOT}/receipts/${release}.json"
python3 - "${receipt}" "${release}" "${source_head}" "${dirty_baseline_digest}" "${native_sha}" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import json, sys
path, release, source, dirty, native = sys.argv[1:]
body = {
    "schema_version": 1,
    "release": release,
    "source_head": source,
    "dirty_baseline_digest": dirty,
    "native_sha256": native,
    "activated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "verified": True,
}
Path(path).write_text(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
Path(path).chmod(0o600)
PY
printf '{"ok":true,"release":"%s","receipt":"%s"}\n' "${release}" "${receipt}"