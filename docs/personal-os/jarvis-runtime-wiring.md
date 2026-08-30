# JARVIS runtime wiring

These components are installed artifacts only. Nothing is enabled by this repository change.

## Commands

Build first with Node 24:

```sh
PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:$PATH npm run build
JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/jarvis-agent-mcp.mjs
JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/jarvis-daily-control.mjs once
JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/jarvis-daily-control.mjs run
JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/jarvis-daily-control.mjs status
JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/jarvis-memory-settlement.mjs <outbox-id>
printf '%s\n' '<redacted-event-json>' | JARVIS_DB=$HOME/.local/share/jarvis/jarvis-authority.sqlite node scripts/collect-terminal-evidence.mjs
```

The agent bridge and provider are line-delimited JSON-RPC/MCP. Their stdout is protocol/status only. Errors are bounded and redacted. `JARVIS_DB` is required. Provider settlement requires `SECOND_BRAIN_PROVIDER_BIN` and optionally `SECOND_BRAIN_PROVIDER_CONFIG`; provider SQLite and vault files are never opened by JARVIS.

## Failure modes

- `MIGRATION_CHECKSUM_MISMATCH` or `MIGRATIONS_PENDING`: stop; do not bypass migration checks.
- `SECOND_BRAIN_PROVIDER_TOOLSET_MISMATCH`, timeout, or child interruption: preserve `uncertain`; reconcile by request status and artifact observation before retrying.
- Daily control reports stale, unavailable, failed, or no-data source state and continues with a degraded brief. It never invokes Second Brain refresh.
- Shell fallback rejects ORCA-present events, secret-shaped fields, private reasoning, keypress/stdin/password data, oversize evidence, and insecure spool permissions.
- Expired or fenced daily/outbox rows are not force-settled. Restart-safe leases require a fresh claim.

## Systemd and rollback

Units under `deploy/` use the absolute Node 24 path, immutable `releases/current`, `UMask=0077`, `ProtectSystem=strict`, loopback/no listener exposure, and explicit writable paths. The settlement worker is the instance unit `jm-jarvis-memory-settlement@.service`; start it with one outbox ID only after review. Review and copy units to `~/.config/systemd/user/` only after a separate owner decision. Do not run `systemctl --user enable`, start, deploy, push, or migrate production as part of verification.

Rollback is stop/disable of only the newly installed unit, restore the previous immutable release pointer, and leave the authority database untouched. Never edit migration 033 or delete outbox evidence. The shell hook installer is opt-in and writes templates with `enabled: false`; it never captures stdin or keypresses.
