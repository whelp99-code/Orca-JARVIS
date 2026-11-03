#!/usr/bin/env bash
# A root publisher must not write the production backup. The runner drops that
# caller to jarvis-svc. The owner check stays "caller uid == directory uid".
_production_backup_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
run_production_backup() {
  local node="${JARVIS_BACKUP_NODE_BIN:-node}"
  local runner="${_production_backup_here}/../../dist/src/production-backup-drop.js"
  local record="${JARVIS_BACKUP_ARGV_LOG:-}"
  if [[ -n "${record}" ]]; then printf '%s\n' "${node} ${runner} --uid $(id -u) --state-root ${JARVIS_STATE_ROOT:-} -- $*" > "${record}"; fi
  "$node" "${runner}" \
    --uid "$(id -u)" --state-root "${JARVIS_STATE_ROOT:-}" -- "$@"
}
