# Operator runbook

1. `node scripts/rehearse-migration.mjs` in an isolated home.
2. Confirm `.omo/evidence/integration/17/happy/index.json` `ok: true`.
3. Production cutover is blocked until the owner signs a snapshot receipt. This rehearsal does not switch launchd.
4. Rollback: restore the snapshot path recorded as `rollbackTarget`. After activation, only a backward-readable binary pointer may move.
5. Legacy `com.cli-jaw.*` jobs stay disabled while JARVIS is running.
