#!/usr/bin/env bash
set -euo pipefail

RUNTIME=/home/jm/.local/state/orca-jarvis
RELEASE="$(readlink -f "$RUNTIME/control-center/current")"
NODE=/home/jm/.nvm/versions/node/v24.19.0/bin/node
KEY=/home/jm/.config/orca-jarvis/portfolio-local.key
DB="$RUNTIME/jarvis.sqlite"

[[ "$RELEASE" =~ ^$RUNTIME/control-center/releases/[0-9a-f]{40}$ ]]
test -z "${SSH_ORIGINAL_COMMAND:-}"
exec "$NODE" "$RELEASE/dist/src/cli.js" portfolio ingest \
  --source local \
  --key-file "$KEY" \
  --db "$DB"
