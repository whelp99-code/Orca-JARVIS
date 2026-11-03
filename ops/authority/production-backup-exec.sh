#!/usr/bin/env bash
# A root publisher must not write the production backup. That directory is owned
# by jarvis-svc, and the backup refuses a caller whose uid is not the owner.
# Drop the caller to jarvis-svc. Do not accept a root-owned directory.
run_production_backup() {
  if [[ "$(id -u)" -eq 0 ]]; then
    sudo -n -u jarvis-svc -- /usr/bin/env "JARVIS_STATE_ROOT=${JARVIS_STATE_ROOT}" "$@"
  else
    "$@"
  fi
}
