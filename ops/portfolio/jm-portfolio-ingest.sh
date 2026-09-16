#!/usr/bin/env bash
set -euo pipefail

# Ingesting half of the spool-and-ingest split (cutover gap G4).
#
# This runs as the account that owns jarvis.sqlite and nothing else: it opens the authority
# database, verifies every spooled envelope against the key, applies it once, and moves it under
# the spool's processed/ ledger. It reads no GUI session and spawns no collector, so it holds the
# database only for the length of one batch.

RUNTIME=${JARVIS_STATE_ROOT:-/home/jm/.local/state/orca-jarvis}
RELEASE="$(readlink -f "$RUNTIME/authority/current")"
NODE=${JARVIS_NODE_BIN:-/home/jm/.nvm/versions/node/v24.19.0/bin/node}
KEY=${JARVIS_PORTFOLIO_KEY:-/home/jm/.config/orca-jarvis/portfolio-jm.key}
SPOOL=${JARVIS_PORTFOLIO_SPOOL_ROOT:-/home/jm/.local/share/jarvis/portfolio-spool}
DB=${JARVIS_DB:-$RUNTIME/jarvis.sqlite}

[[ "$RELEASE" =~ ^$RUNTIME/authority/releases/[0-9a-f]{40}$ ]]

"$NODE" "$RELEASE/dist/src/cli.js" portfolio ingest \
  --spool "$SPOOL" \
  --source jm-server \
  --key-file "$KEY" \
  --db "$DB"
