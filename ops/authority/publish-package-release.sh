#!/usr/bin/env bash
# Publishes an already-verified runtime package as an authority release.
#
# This publishes the package it was given. It does not rebuild from a worktree, so the bytes that
# were verified are the bytes that get published, and the pinned receipt hash must be kept
# independently of the candidate (never derived from it at publish time).
#
# It refuses to move `current` unless --activate is given together with the owner
# production-activation-gate evidence. Without --activate it publishes, gates and backs up, and
# leaves `current` exactly where it was.
#
# Published payload files are mode 0644 and directories 0755 under umask 0022, because the task
# verifier rejects any published file with `mode & 0o022`. The release root, its releases/ and its
# receipts/ are 0700, so the private parent restricts who can reach the published tree at all.
set -euo pipefail
umask 0022

readonly OWNER_GATE="JARVIS_PRODUCTION_ACTIVATION_APPROVAL"
readonly PRODUCTION_DB="/home/jm/.local/state/orca-jarvis/jarvis.sqlite"
readonly PRODUCTION_BACKUP_ROOT="/home/jm/.local/state/orca-jarvis/backups"

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

PACKAGE=""
PIN=""
RELEASE_ROOT=""
DB=""
BACKUP_ROOT=""
DASHBOARD_URL=""
ACTIVATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGE="${2:-}"; shift 2 ;;
    --receipt-sha256) PIN="${2:-}"; shift 2 ;;
    --release-root) RELEASE_ROOT="${2:-}"; shift 2 ;;
    --db) DB="${2:-}"; shift 2 ;;
    --backup-root) BACKUP_ROOT="${2:-}"; shift 2 ;;
    --dashboard-url) DASHBOARD_URL="${2:-}"; shift 2 ;;
    --activate) ACTIVATE=1; shift ;;
    *) fail 'PACKAGE_RELEASE_USAGE' 2 ;;
  esac
done

[[ -n "${PACKAGE}" && -n "${PIN}" && -n "${RELEASE_ROOT}" && -n "${DB}" ]] || fail 'PACKAGE_RELEASE_USAGE' 2
[[ "${PIN}" =~ ^[0-9a-f]{64}$ ]] || fail 'PACKAGE_RELEASE_USAGE' 2
[[ "${PACKAGE}" = /* && "${RELEASE_ROOT}" = /* && "${DB}" = /* ]] || fail 'PACKAGE_RELEASE_USAGE' 2
[[ -d "${PACKAGE}" ]] || fail 'PACKAGE_RELEASE_CANDIDATE_UNAVAILABLE'
[[ -f "${DB}" ]] || fail 'PACKAGE_RELEASE_DATABASE_UNAVAILABLE'

# The owner gate is checked before anything is published, so a refused activation never leaves a
# half-published release behind.
if [[ "${ACTIVATE}" -eq 1 && "${!OWNER_GATE:-}" != "approved" ]]; then
  fail 'JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED' 2
fi

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly WORKTREE="${JARVIS_PUBLISH_WORKTREE:-$(cd -- "${here}/../.." && pwd)}"
NODE_BIN="${JARVIS_NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -x "${NODE_BIN}" ]] || fail 'PACKAGE_RELEASE_NODE_UNAVAILABLE'
[[ -f "${WORKTREE}/scripts/verify-runtime-package.mjs" ]] || fail 'PACKAGE_RELEASE_VERIFIER_UNAVAILABLE'

verified="$("${NODE_BIN}" "${WORKTREE}/scripts/verify-runtime-package.mjs" \
  "${PACKAGE}" --receipt-sha256 "${PIN}")" || fail 'PACKAGE_RELEASE_VERIFICATION_FAILED'
source_head="$(printf '%s' "${verified}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["source_head"])')"
[[ "${source_head}" =~ ^[0-9a-f]{40}$ ]] || fail 'PACKAGE_RELEASE_SOURCE_HEAD_INVALID'

mkdir -p -m 0700 "${RELEASE_ROOT}" "${RELEASE_ROOT}/releases" "${RELEASE_ROOT}/receipts"
chmod 0700 "${RELEASE_ROOT}" "${RELEASE_ROOT}/releases" "${RELEASE_ROOT}/receipts"
release_path="${RELEASE_ROOT}/releases/${source_head}"
# Exclusive create: a release directory that already exists is never written into or renamed over.
mkdir "${release_path}" 2>/dev/null || fail 'PACKAGE_RELEASE_ALREADY_PUBLISHED'

payload_roots="$("${NODE_BIN}" --input-type=module -e \
  'import { RUNTIME_PACKAGE_ROOTS } from "'"${WORKTREE}"'/scripts/lib/runtime-package-roots.mjs";
   console.log(RUNTIME_PACKAGE_ROOTS.join("\n"));')"
while IFS= read -r name; do
  [[ -n "${name}" ]] || continue
  [[ -e "${PACKAGE}/${name}" ]] || fail 'PACKAGE_RELEASE_PAYLOAD_INCOMPLETE'
  mkdir -p "${release_path}/$(dirname -- "${name}")"
  cp -a -- "${PACKAGE}/${name}" "${release_path}/${name}"
done <<<"${payload_roots}"
# Installed dependencies travel with the payload as hard links; they are what makes the published
# CLI runnable without a source checkout.
if [[ -d "${PACKAGE}/node_modules" ]]; then
  cp -al -- "${PACKAGE}/node_modules" "${release_path}/node_modules"
fi

while IFS= read -r name; do
  [[ -n "${name}" ]] || continue
  find "${release_path}/${name}" -type d -exec chmod 0755 -- {} +
  find "${release_path}/${name}" ! -type d ! -type l -exec chmod 0644 -- {} +
done <<<"${payload_roots}"
chmod 0755 "${release_path}"

gates="$("${NODE_BIN}" "${release_path}/dist/src/cli.js" release gates --db "${DB}" \
  ${DASHBOARD_URL:+--dashboard-url "${DASHBOARD_URL}"})" || {
  printf '%s\n' "${gates:-PACKAGE_RELEASE_GATES_FAILED}" >&2
  fail 'PACKAGE_RELEASE_GATES_FAILED'
}

if [[ "${DB}" == "${PRODUCTION_DB}" ]]; then
  backup="$("${NODE_BIN}" "${release_path}/dist/src/personal-os-backup-cli.js" \
    --db "${DB}" --backup-root "${PRODUCTION_BACKUP_ROOT}" --production)" || fail 'PACKAGE_RELEASE_BACKUP_FAILED'
else
  backup="$("${NODE_BIN}" "${release_path}/dist/src/personal-os-backup-cli.js" \
    --db "${DB}" --backup-root "${BACKUP_ROOT:-${RELEASE_ROOT}/backups/${source_head}}")" \
    || fail 'PACKAGE_RELEASE_BACKUP_FAILED'
fi

activated=0
current_target="$(readlink -- "${RELEASE_ROOT}/current" 2>/dev/null || true)"
if [[ "${ACTIVATE}" -eq 1 ]]; then
  temporary="${RELEASE_ROOT}/.current-${source_head}-$$"
  rm -f -- "${temporary}"
  ln -s "releases/${source_head}" "${temporary}"
  mv -Tf -- "${temporary}" "${RELEASE_ROOT}/current"
  [[ "$(readlink -- "${RELEASE_ROOT}/current")" == "releases/${source_head}" ]] \
    || fail 'PACKAGE_RELEASE_ACTIVATION_FAILED'
  current_target="releases/${source_head}"
  activated=1
fi

receipt="${RELEASE_ROOT}/receipts/${source_head}.json"
python3 - "${receipt}" "${release_path}" "${RELEASE_ROOT}" "${source_head}" "${PIN}" \
  "${activated}" "${gates}" "${backup}" "${verified}" <<'PY'
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json, os, sys

receipt_path, release, release_root, source_head, pin, activated, gates, backup, verified = sys.argv[1:]
release = Path(release)
entries = []
for path in sorted(p for p in release.rglob("*") if "node_modules" not in p.relative_to(release).parts):
    rel = path.relative_to(release).as_posix()
    mode = path.lstat().st_mode & 0o777
    if path.is_symlink():
        entries.append({"path": rel, "type": "symlink", "mode": mode, "target": os.readlink(path)})
    elif path.is_dir():
        entries.append({"path": rel, "type": "directory", "mode": mode})
    else:
        body = path.read_bytes()
        entries.append({"path": rel, "type": "file", "mode": mode, "size": len(body),
                        "sha256": sha256(body).hexdigest()})

digest = sha256(b"orca-jarvis/package-release-payload/v1\0")
digest.update(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode())
files = [entry for entry in entries if entry["type"] == "file"]
group_other_writable = sorted(entry["path"] for entry in files if entry["mode"] & 0o022)
if group_other_writable:
    raise SystemExit("PACKAGE_RELEASE_PAYLOAD_MODE_INVALID")

# The provider contract the release is sealed against, when a provider release is published here.
provider_manifest = Path(release_root) / "provider-releases" / "current" / "release.manifest.json"
provider_digest = None
if provider_manifest.is_file():
    provider_digest = json.loads(provider_manifest.read_text())["payload_digest"]

body = {
    "schema_version": 1,
    "kind": "authority-package-release",
    "release": source_head,
    "source_head": source_head,
    "package_receipt_sha256": pin,
    "payload_digest": digest.hexdigest(),
    "payload_files": len(files),
    "payload_file_modes": sorted({entry["mode"] for entry in files}),
    "verification": json.loads(verified),
    "gates": json.loads(gates),
    "backup": json.loads(backup),
    "activated": activated == "1",
    "activated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z") if activated == "1" else None,
    "published_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "runtime_validation": "gates_only",
    "deployment_ready": False,
}
if provider_digest is not None:
    body["provider_contract_digest"] = provider_digest
Path(receipt_path).write_text(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
Path(receipt_path).chmod(0o644)
PY

printf '{"ok":true,"release":"%s","release_path":"%s","receipt":"%s","activated":%s,"current":"%s"}\n' \
  "${source_head}" "${release_path}" "${receipt}" \
  "$([[ "${activated}" -eq 1 ]] && printf 'true' || printf 'false')" "${current_target}"
