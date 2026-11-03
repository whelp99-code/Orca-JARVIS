#!/usr/bin/env bash
# A root publisher must not write the production backup. The runner drops that
# caller to jarvis-svc. The owner check stays "caller uid == directory uid".
_production_backup_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
run_production_backup() {
  local node="${NODE_BIN:-node}"
  "$node" "${_production_backup_here}/production-backup-exec.mjs" \
    --uid "$(id -u)" --state-root "${JARVIS_STATE_ROOT:-}" -- "$@"
}
