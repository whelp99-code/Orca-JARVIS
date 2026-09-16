#!/usr/bin/env bash
set -euo pipefail

# Collecting half of the spool-and-ingest split (cutover gap G4).
#
# This runs as the interactive user, because it reads that user's Orca GUI session through
# orca-ide, and it opens no authority database: it writes one signed, self-describing envelope
# into the spool directory and exits. The ingesting half (jm-portfolio-ingest.sh) runs as whoever
# owns jarvis.sqlite, which after the jarvis-svc cutover is not this account.

RUNTIME=${JARVIS_STATE_ROOT:-/home/jm/.local/state/orca-jarvis}
RELEASE="$(readlink -f "$RUNTIME/control-center/current")"
NODE=${JARVIS_NODE_BIN:-/home/jm/.nvm/versions/node/v24.19.0/bin/node}
ORCA=${JARVIS_ORCA_BIN:-/home/jm/.local/bin/orca-ide}
GIT=/usr/bin/git
# The HMAC key must be 0600 and owned by the account reading it, so the collector and the ingest
# each hold their own copy of the same key bytes.
KEY=${JARVIS_PORTFOLIO_KEY:-/home/jm/.config/orca-jarvis/portfolio-jm.key}
SPOOL=${JARVIS_PORTFOLIO_SPOOL_ROOT:-/home/jm/.local/share/jarvis/portfolio-spool}

[[ "$RELEASE" =~ ^$RUNTIME/control-center/releases/[0-9a-f]{40}$ ]]

"$NODE" "$RELEASE/dist/src/cli.js" portfolio collect \
  --spool "$SPOOL" \
  --source jm-server \
  --key-file "$KEY" \
  --orca-bin "$ORCA" \
  --git-bin "$GIT"
