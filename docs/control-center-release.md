# Control Center release and LaunchAgent

Definitions only. Do not run the commands below until an operator explicitly deploys. This file does not change live production state.

JM-SERVER uses the separate systemd procedure in [`jm-control-center-release.md`](./jm-control-center-release.md).

Production runtime root: `/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime`.
Dashboard label: `com.jmpark.orca-jarvis-dashboard`.
Existing supervisor label `com.jmpark.orca-jarvis` stays untouched.

## Backup

```bash
DB=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite
RUNTIME=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$RUNTIME/backups/pre-jcc-$STAMP.sqlite"

sqlite3 -readonly "$DB" 'PRAGMA quick_check;'
sqlite3 "$DB" ".timeout 5000" ".backup '$BACKUP'"
sqlite3 -readonly "$BACKUP" 'PRAGMA quick_check;'
shasum -a 256 "$BACKUP" | tee "$BACKUP.sha256"

cp -p "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist" \
  "$RUNTIME/backups/com.jmpark.orca-jarvis-dashboard.$STAMP.plist" 2>/dev/null || true
```

Do not restore the SQLite backup for a dashboard startup failure.

## Build from merged main

Build only an archive of the merged main commit. Do not switch, pull, reset, clean, or build inside the dirty production checkout.

```bash
MERGE_SHA="$(git rev-parse origin/main)"
ROOT="$RUNTIME/control-center"
STAGE="$(mktemp -d "$ROOT/.stage.XXXXXX")"
mkdir -p "$STAGE/source"
git archive "$MERGE_SHA" | tar -x -C "$STAGE/source"
( cd "$STAGE/source" && npm ci && npm run verify )
mkdir -p "$STAGE/release"
cp "$STAGE/source/package.json" "$STAGE/source/package-lock.json" "$STAGE/release/"
cp -R "$STAGE/source/dist" "$STAGE/release/"
( cd "$STAGE/release" && npm ci --omit=dev )
```

Publish with the repository script. It validates package files plus `dist/src/dashboard/server.js` and `dist/dashboard` before mutation, refuses a mismatched `releases/<sha>`, renames the staged tree on the same filesystem, and atomically updates relative `current -> releases/<sha>`.

```bash
node scripts/publish-control-center-release.mjs \
  --stage "$STAGE/release" \
  --runtime-root "$ROOT" \
  --sha "$MERGE_SHA"
```

Prior `releases/<sha>` directories stay in place for rollback.

## LaunchAgent

Copy the repo plist onto the boot volume before `launchctl bootstrap`. Bootstrapping the plist from the external DevSpace volume returns launchd I/O error 5.

```bash
install -m 600 \
  deploy/com.jmpark.orca-jarvis-dashboard.plist \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"
launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"
launchctl kickstart -k "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard"
```

The definition binds `127.0.0.1:4173` only. It contains no secrets.

## Health, SSE, and browser gates

```bash
curl -fsS http://127.0.0.1:4173/api/v1/health
curl -fsS http://127.0.0.1:4173/api/v1/overview
curl -N --max-time 3 http://127.0.0.1:4173/api/v1/events
JARVIS_DASHBOARD_URL=http://127.0.0.1:4173 \
  npx playwright test e2e/production-smoke.spec.ts --project=chromium-1440
```

Production smoke is GET/SSE only. If any gate fails, roll back.

## Rollback

Keep the previous release directory. Relink `current`, restore the previous dashboard plist if one was backed up, and reload only the dashboard label.

```bash
launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard" || true
PREVIOUS=<previous-40-hex>
ROOT=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center
TMP="$ROOT/.current-$PREVIOUS"
rm -f "$TMP"
ln -s "releases/$PREVIOUS" "$TMP"
mv -f "$TMP" "$ROOT/current"
# restore backed-up plist to ~/Library/LaunchAgents if it existed
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"
```

Do not restart `com.jmpark.orca-jarvis`. Do not edit the production source tree.
