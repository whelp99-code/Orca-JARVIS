# Dual-host portfolio collectors

Status: Mac LaunchAgent/`/Volumes/DevSpace` LOCAL install steps below are `HISTORICAL_NON_EXECUTABLE`. Do not `launchctl` bootstrap a Mac portfolio agent from this file. Linux collector units: `deploy/jm-jarvis-portfolio-collector.service` and `deploy/jm-jarvis-portfolio-collector.timer`. Linux authority docs: `docs/personal-os/operations.md`.

The portfolio dashboard uses one source-owned collector per host. JM-SERVER accepts LOCAL reports only through a restricted SSH key whose forced command is the LOCAL ingest wrapper.

## The JM-SERVER collector is split in two

Collection and ingest are separate units, because they must be able to run as different accounts.
`portfolio collect --spool DIR` reads the host through `orca-ide` and writes one signed envelope
into the spool; it opens no database, so it stays with the interactive user who owns the GUI
session it reads. `portfolio ingest --spool DIR --db PATH` opens the authority database, verifies
each envelope and consumes it once — the spool's `processed/` directory is the digest ledger, and a
refused envelope is quarantined under `refused/` and reported by name and code.

- `ops/portfolio/jm-portfolio-collector.sh` + `jm-jarvis-portfolio-collector.service`/`.timer`
- `ops/portfolio/jm-portfolio-ingest.sh` + `jm-jarvis-portfolio-ingest.service`/`.timer`
- Spool root: `JARVIS_PORTFOLIO_SPOOL_ROOT`, default `<JARVIS_SHARE_ROOT>/portfolio-spool`.

`readPortfolioHmacKey` requires mode `0600` owned by the reading account, so when the two halves
run as different accounts each holds its own copy of the same key bytes. Installing both units
under one account is the per-host default and needs no second copy.

## Secret and identity boundaries

- LOCAL signing key: `/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/secrets/portfolio-local.key`.
- JM copy of the LOCAL verification key: `/home/jm/.config/orca-jarvis/portfolio-local.key`.
- JM signing key: `/home/jm/.config/orca-jarvis/portfolio-jm.key`.
- LOCAL SSH identity: `~/.ssh/jarvis-portfolio-ingest`.
- All private keys are regular files with mode `0600`; directories use `0700`.
- Signing keys and the SSH private key never enter Git or a release archive.
- The forced command rejects any `SSH_ORIGINAL_COMMAND`.

Generate each HMAC key independently and install the LOCAL value on JM over an already trusted administrative channel:

```bash
umask 077
KEY_PATH="<absolute-key-path>"
key="$(openssl rand -hex 32)"
test "${#key}" -eq 64
printf '%s' "$key" > "$KEY_PATH"
chmod 0600 "$KEY_PATH"
test -f "$KEY_PATH" && test ! -L "$KEY_PATH"
test "$(wc -c < "$KEY_PATH" | tr -d ' ')" -eq 64
test "$(stat -f %Su "$KEY_PATH" 2>/dev/null || stat -c %U "$KEY_PATH")" = "$(id -un)"
```

## JM-SERVER installation

Install the committed wrappers and systemd units from the active full-SHA release:

```bash
RELEASE=/home/jm/.local/state/orca-jarvis/control-center/current
install -d -m 0700 /home/jm/.config/orca-jarvis
install -d -m 0750 /home/jm/.config/systemd/user
install -m 0644 "$RELEASE/ops/portfolio/jm-jarvis-portfolio-collector.service" \
  /home/jm/.config/systemd/user/jm-jarvis-portfolio-collector.service
install -m 0644 "$RELEASE/ops/portfolio/jm-jarvis-portfolio-collector.timer" \
  /home/jm/.config/systemd/user/jm-jarvis-portfolio-collector.timer
systemctl --user daemon-reload
test "$(loginctl show-user jm -p Linger --value)" = yes
systemctl --user enable --now jm-jarvis-portfolio-collector.timer
```

The LOCAL public key entry in `/home/jm/.ssh/authorized_keys` must use:

```text
from="<LOCAL_TAILSCALE_IP>",restrict,command="/bin/bash /home/jm/.local/state/orca-jarvis/control-center/current/ops/portfolio/local-portfolio-ingest.sh" ssh-ed25519 <public-key> jarvis-portfolio-ingest
```

## LOCAL installation

Status: `HISTORICAL_NON_EXECUTABLE`. The following LaunchAgent recipe is archive text only. Do not install it.

Install the publisher and LaunchAgent from the active full-SHA release:

```bash
RUNTIME=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime
RELEASE="$RUNTIME/control-center/current"
install -d -m 0700 "$RUNTIME/secrets"
install -d -m 0750 "$RUNTIME/logs" "$HOME/Library/LaunchAgents"
install -m 0644 "$RELEASE/ops/portfolio/com.jmpark.orca-jarvis-portfolio.plist" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-portfolio.plist"
launchctl print "gui/$(id -u)/com.jmpark.orca-jarvis-portfolio" >/dev/null 2>&1 \
  && launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-portfolio"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-portfolio.plist"
launchctl kickstart -k "gui/$(id -u)/com.jmpark.orca-jarvis-portfolio"
```

The plist must live in `~/Library/LaunchAgents`; launchd cannot bootstrap this project’s external-volume copy directly.
The LOCAL schedule intentionally runs only while the user’s GUI launchd domain exists. Missed intervals while logged out or asleep are not replayed; the next logged-in interval publishes current state.

## Verification and rollback

```bash
systemctl --user start jm-jarvis-portfolio-collector.service
systemctl --user status jm-jarvis-portfolio-collector.timer --no-pager
journalctl --user-unit jm-jarvis-portfolio-collector.service -n 30 --no-pager

launchctl print "gui/$(id -u)/com.jmpark.orca-jarvis-portfolio"
tail -n 30 /Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/logs/portfolio-local.stderr.log
```

After both collectors run, the overview must show each host with a recent `updated_at` and `collector_status=ok`. To roll back, disable the timer and boot out the LaunchAgent; leave the keys and last stored projections intact:

```bash
systemctl --user disable --now jm-jarvis-portfolio-collector.timer
launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-portfolio"
```

Forward recovery re-enables the timer, bootstraps the LaunchAgent from the selected release, and proves both sources update again.
