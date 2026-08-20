#!/usr/bin/env bash
set -euo pipefail

RUNTIME=/home/jm/.local/state/orca-jarvis
RELEASE="$(readlink -f "$RUNTIME/control-center/current")"
NODE=/home/jm/.nvm/versions/node/v24.19.0/bin/node
ORCA=/home/jm/.local/bin/orca-ide
GIT=/usr/bin/git
KEY=/home/jm/.config/orca-jarvis/portfolio-jm.key
DB="$RUNTIME/jarvis.sqlite"

[[ "$RELEASE" =~ ^$RUNTIME/control-center/releases/[0-9a-f]{40}$ ]]

"$NODE" "$RELEASE/dist/src/dashboard/portfolio-collector-main.js" \
  --source jm-server \
  --key-file "$KEY" \
  --orca-bin "$ORCA" \
  --git-bin "$GIT" \
| "$NODE" "$RELEASE/dist/src/cli.js" portfolio ingest \
    --source jm-server \
    --key-file "$KEY" \
    --db "$DB"
