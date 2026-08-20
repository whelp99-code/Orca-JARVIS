# JM-SERVER control center release and rollback

Definitions only. These commands change JM-SERVER production state and require operator authorization.

Runtime root: `/home/jm/.local/state/orca-jarvis`.
Release root: `$RUNTIME/control-center/releases`.
Dashboard unit: `jm-jarvis-dashboard.service`.
Authority database: `$RUNTIME/jarvis.sqlite`.

## Invariants

- Release only a full 40-hex commit that is already merged into `origin/main`.
- Build from `git archive`; never build, reset, clean, or switch the dirty production checkout.
- Use `releases/<merge-sha>` and a relative `current -> releases/<merge-sha>` symlink.
- Create and quick-check a SQLite backup before applying forward migrations.
- Install Linux dependencies inside the unactivated release and prove Node ABI compatibility.
- Restart only `jm-jarvis-dashboard.service`; do not restart the JARVIS supervisor.
- Rollback changes only the release symlink. Do not restore the database for an additive dashboard failure.

## Stage merged main

Run from a clean repository that can read `origin/main`:

```bash
set -euo pipefail
RUNTIME=/home/jm/.local/state/orca-jarvis
git fetch origin main
MERGE_SHA="$(git rev-parse origin/main)"
test "${#MERGE_SHA}" -eq 40
git merge-base --is-ancestor "$MERGE_SHA" origin/main

STAGE="$(mktemp -d -t jarvis-jm-release.XXXXXX)"
mkdir -p "$STAGE/source"
git archive "$MERGE_SHA" | tar -x -C "$STAGE/source"
( cd "$STAGE/source" && npm ci && npm run verify )

test -f "$STAGE/source/dist/src/dashboard/portfolio-collector-main.js"
test -f "$STAGE/source/config/portfolio-repositories.json"
test -f "$STAGE/source/config/portfolio-status.json"
test -f "$STAGE/source/ops/portfolio/jm-jarvis-portfolio-collector.service"
test -f "$STAGE/source/ops/portfolio/com.jmpark.orca-jarvis-portfolio.plist"

tar -C "$STAGE/source" -cf - \
  dist package.json package-lock.json config ops \
| ssh jm@100.87.81.57 \
  "set -e; RELEASE='$RUNTIME/control-center/releases/$MERGE_SHA'; \
   test ! -e \"\$RELEASE\"; mkdir -m 0770 \"\$RELEASE\"; tar -xf - -C \"\$RELEASE\""
```

## Install and verify Linux dependencies

JM-SERVER runs Node `v24.19.0` with module ABI `137`.

```bash
RUNTIME=/home/jm/.local/state/orca-jarvis
MERGE_SHA="${MERGE_SHA:?set MERGE_SHA to the verified merged commit}"
ssh jm@100.87.81.57 "
  set -euo pipefail
  RELEASE='$RUNTIME/control-center/releases/$MERGE_SHA'
  export PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin
  NODE=/home/jm/.nvm/versions/node/v24.19.0/bin/node
  NPM=/home/jm/.nvm/versions/node/v24.19.0/bin/npm
  cd \"\$RELEASE\"
  \"\$NPM\" ci --omit=dev
  npm_config_build_from_source=true \"\$NPM\" rebuild better-sqlite3 --foreground-scripts
  \"\$NODE\" --input-type=module -e '
    import Database from \"better-sqlite3\";
    const db = new Database(\":memory:\");
    if (process.versions.modules !== \"137\") process.exit(1);
    if (db.pragma(\"quick_check\", { simple: true }) !== \"ok\") process.exit(1);
    db.close();
  '
"
```

Do not activate a release whose native module smoke test fails.

## Backup and migrate the authority database

JM-SERVER does not require a system `sqlite3` executable. Use the release's verified `better-sqlite3`.

```bash
RUNTIME=/home/jm/.local/state/orca-jarvis
MERGE_SHA="${MERGE_SHA:?set MERGE_SHA to the verified merged commit}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$RUNTIME/backups/jarvis-before-$MERGE_SHA-$STAMP.sqlite"

ssh jm@100.87.81.57 "
  set -euo pipefail
  RELEASE='$RUNTIME/control-center/releases/$MERGE_SHA'
  DB='$RUNTIME/jarvis.sqlite'
  BACKUP='$BACKUP'
  mkdir -p '$RUNTIME/backups'
  test ! -e \"\$BACKUP\"
  cd \"\$RELEASE\"
  DB_PATH=\"\$DB\" BACKUP_PATH=\"\$BACKUP\" \
    /home/jm/.nvm/versions/node/v24.19.0/bin/node --input-type=module -e '
      import Database from \"better-sqlite3\";
      const db = new Database(process.env.DB_PATH);
      if (db.pragma(\"quick_check\", { simple: true }) !== \"ok\") process.exit(1);
      await db.backup(process.env.BACKUP_PATH);
      db.close();
    '
  test -s \"\$BACKUP\"
  /home/jm/.nvm/versions/node/v24.19.0/bin/node \
    dist/src/cli.js db migrate --db \"\$DB\"
"
```

## Activate atomically

```bash
RUNTIME=/home/jm/.local/state/orca-jarvis
MERGE_SHA="${MERGE_SHA:?set MERGE_SHA to the verified merged commit}"
ssh jm@100.87.81.57 "
  set -euo pipefail
  ROOT='$RUNTIME/control-center'
  cd \"\$ROOT\"
  test -d \"releases/$MERGE_SHA\"
  rm -f current.next
  ln -s \"releases/$MERGE_SHA\" current.next
  mv -Tf current.next current
  systemctl --user restart jm-jarvis-dashboard.service
  systemctl --user is-active jm-jarvis-dashboard.service
  test \"\$(readlink -f current)\" = \"\$ROOT/releases/$MERGE_SHA\"
  /home/jm/.nvm/versions/node/v24.19.0/bin/node --input-type=module -e '
    const health = await (await fetch(\"http://127.0.0.1:4173/api/v1/health\")).json();
    const overview = await (await fetch(\"http://127.0.0.1:4173/api/v1/overview\")).json();
    if (health.status !== \"ok\" || health.authority !== \"ready\") process.exit(1);
    if (!Array.isArray(overview.portfolio?.hosts) || overview.portfolio.hosts.length !== 2) process.exit(1);
    if (!overview.portfolio.hosts.every((host) => host.collector_status === \"ok\")) process.exit(1);
  '
"
```

Completion requires health `status=ok`, `authority=ready`, an overview with two portfolio hosts, and a current symlink resolving to the merged commit release.

## Rollback and forward recovery

```bash
RUNTIME=/home/jm/.local/state/orca-jarvis
MERGE_SHA="${MERGE_SHA:?set MERGE_SHA to the verified merged commit}"
PREVIOUS_SHA="<previous-40-hex-release>"

ssh jm@100.87.81.57 "
  set -euo pipefail
  ROOT='$RUNTIME/control-center'
  cd \"\$ROOT\"
  test -d \"releases/$PREVIOUS_SHA\"
  rm -f current.next
  ln -s \"releases/$PREVIOUS_SHA\" current.next
  mv -Tf current.next current
  systemctl --user restart jm-jarvis-dashboard.service
  systemctl --user is-active jm-jarvis-dashboard.service
  test \"\$(readlink -f current)\" = \"\$ROOT/releases/$PREVIOUS_SHA\"
  /home/jm/.nvm/versions/node/v24.19.0/bin/node --input-type=module -e '
    const response = await fetch(\"http://127.0.0.1:4173/api/v1/health\");
    const health = await response.json();
    if (!response.ok || health.status !== \"ok\" || health.authority !== \"ready\") process.exit(1);
  '
"
```

Forward recovery repeats the atomic activation with `$MERGE_SHA` and verifies both health and portfolio overview. Keep the pre-migration backup and both immutable release directories until the release has completed its observation window.
