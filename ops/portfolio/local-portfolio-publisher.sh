#!/usr/bin/env bash
set -euo pipefail

RUNTIME=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime
RELEASE="$(cd -P "$RUNTIME/control-center/current" && pwd)"
NODE=/Users/jmpark/.nvm/versions/node/v24.19.0/bin/node
ORCA=/Users/jmpark/.local/bin/orca
GH=/opt/homebrew/bin/gh
GIT=/opt/homebrew/bin/git
KEY="$RUNTIME/secrets/portfolio-local.key"
SSH_KEY=/Users/jmpark/.ssh/jarvis-portfolio-ingest
KNOWN_HOSTS=/Users/jmpark/.ssh/known_hosts
# Destination renames require verified host-key provisioning first; see docs/portfolio-collectors.md.
# Never bypass StrictHostKeyChecking or copy an old IP entry under a new name without verification.
INGEST_SSH_TARGET="${JARVIS_PORTFOLIO_INGEST_SSH_TARGET:-jm@jm-omachy}"

[[ "$RELEASE" =~ ^$RUNTIME/control-center/releases/[0-9a-f]{40}$ ]]

"$NODE" "$RELEASE/dist/src/dashboard/portfolio-collector-main.js" \
  --source local \
  --key-file "$KEY" \
  --scope-file "$RELEASE/config/portfolio-repositories.json" \
  --status-file "$RELEASE/config/portfolio-status.json" \
  --orca-bin "$ORCA" \
  --gh-bin "$GH" \
  --git-bin "$GIT" \
| /usr/bin/ssh \
    -T \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$KNOWN_HOSTS" \
    -o ConnectTimeout=5 \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=2 \
    -i "$SSH_KEY" \
    "$INGEST_SSH_TARGET"
