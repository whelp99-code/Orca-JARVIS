# Personal OS disaster recovery (Linux)

Task 36 rehearses backup/restore only in an isolated mirror. Production restore is gated.

## RPO {#restore}

- JARVIS online backup RPO: `jarvis-rpo-15m`
- Provider sealed-generation backup RPO: `provider-rpo-25h`

Safe restore order:

1. `restore-new-generation`
2. `tombstones-before-read`
3. `proof-before-activation`

Never restore onto the live generation or the live `authority/current` symlink from this document.

## Backup owners

JARVIS backup is `jarvis-owner` (`jm-jarvis-backup.service` / `jm-jarvis-backup.timer`).
Provider backup is `provider-owner` (`jm-second-brain-backup.service` / `jm-second-brain-backup.timer`).

Production database copies and live unit enablement are outside Task 36 (`systemd-runtime-skipped`).
