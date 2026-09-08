# Native evening systemd candidate

2026-09-09. Backlog 12. Prepare a user service and timer for the existing signed
`daily evening --once` command. These two files are staged deployment candidates;
they are not installed, enabled, or part of the frozen production unit inventory.
Automatic operation remains HOLD. This change does not certify production use.

## Execution contract

The timer uses explicit `Asia/Seoul`, daily at 21:30, matching
`dailyLoopSchedules`. Accuracy is one second with no randomized delay. The service
uses the existing Node 24.19.0 and immutable-release `authority/current` paths,
the existing authority database, and operator-owned config/key files:

- `/home/jm/.config/orca-jarvis/evening.json`: the closed configuration documented
  in [the CLI ADR](adr-native-evening-cli.md).
- `/home/jm/.config/orca-jarvis/evening.pem`: Ed25519 private key belonging to the
  effective user, regular file, no symlink, no group/other permission bits.

The pinned public key must match the private key. Configure the same trusted key
as `trusted_closeout_key` in the morning input before both phases share this DB.
Use authorized repository identity digests; an empty scope intentionally selects
no completions. Do not substitute approval keys or invent provenance.

No database migration, key creation, or restart command is embedded. The one-shot
has a 120-second process timeout and no automatic failure retry. The CLI's lease,
deadline, source visibility, and budget checks remain authoritative; the process
timeout does not extend them. A timeout can leave a claimed/uncertain run for
explicit inspection, and must not be treated as a successful report.

`Persistent=true` requests a catch-up activation after missed timer events. It
does not replay every missed day or override the CLI recovery policy. The CLI
only publishes the current KST day's eligible evening, within configured recovery
limits. A catch-up before today's evening can exit successfully with no report.
An invocation outside the recovery window is not evidence of daily completion.
Inspect the structured result and stored publication, not just systemd exit status.

## Acceptance before activation

1. Select a tested immutable release containing the evening CLI and required
   migrations, and confirm the actual host Node path. Follow the existing release
   procedure for deployment and database backup/migration.
2. Provision the operator config and signing key, morning trust, authorized source
   scope, and real native source provenance. Check the report omissions and HOLD
   conditions; fixture provenance is not operational evidence.
3. Exercise the exact service in an isolated user-manager environment with its
   hardening and persistent timer, including restart/missed-time behavior, key
   rejection, timeouts, duplicate invocation, and publication read-back.
4. Update the production unit inventory and installation/rollback procedure only
   after the candidate is accepted. Obtain explicit operator authorization for
   production activation. Do not bulk-install `deploy/*` as part of this change.

The service borrows existing backup-unit filesystem hardening. Parser success does
not prove this host permits user-service sandboxing or that runtime paths/config
exist. No production manager reload, timer enable, service start, or DB write was
performed for this candidate.

## Local checks

Run from the checkout, without installing units:

```sh
systemd-analyze --user verify deploy/jm-jarvis-evening.service deploy/jm-jarvis-evening.timer
systemd-analyze calendar --base-time='2026-09-09 00:00:00 UTC' --iterations=2 '*-*-* 21:30:00 Asia/Seoul'
```

Record parser failures as failures rather than deleting security directives to
obtain a green check. Calendar output should resolve the next two events to
2026-09-09 and 2026-09-10 at 12:30 UTC / 21:30 KST.

Observed on systemd 259 (259.5-0ubuntu3.4): user-unit verification exited 0;
the host's unrelated `/usr/lib/systemd/user/spice-vdagent.service:23` emitted an
unknown `StandardError` key warning in its Install section. Calendar verification
exited 0 and returned both expected dates/times above. `git diff --cached --check`
exited 0. These checks parse files only; the candidate service was not executed.
