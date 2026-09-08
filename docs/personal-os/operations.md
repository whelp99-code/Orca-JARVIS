# Personal OS operations (Linux authority)

Machine facts for operators. Executable production steps require the named owner gates. Task 36 does not activate production.

## Host {#host}

- Authority and scheduling: `linux-authority` `linux-scheduler`
- Second Brain effects: `provider-owned-effects`
- Mac/phone: `mac-client-only`

## Units {#units}

`jarvis-owner`: `jm-jarvis.service` `jm-jarvis-dashboard.service` `jm-jarvis-phone-gateway.service` `jm-jarvis-backup.service` `jm-jarvis-backup.timer` `jm-jarvis-portfolio-collector.service` `jm-jarvis-portfolio-collector.timer`

`provider-owner`: `jm-second-brain-refresh.service` `jm-second-brain-refresh.timer` `jm-second-brain-requests.service` `jm-second-brain-requests.path` `jm-second-brain-backup.service` `jm-second-brain-backup.timer`

## Intended schedule {#schedule}

These are the configured operating targets. This list alone does not prove that daily producers,
scheduler units, or external adapters are active; verify each runtime and its output separately.

- Refresh `07:00-Asia/Seoul`
- Morning `07:15-Asia/Seoul`
- Closeout `21:30-Asia/Seoul`
- Retention `02:30-Asia/Seoul`
- Quiet hours `22:00-07:00-Asia/Seoul`

## Provider settlement {#provider}

Provider write acceptance is `accepted-reconciling` until `signed-provider-proof`. There is `no-auto-replay`. Missing proof is `visible-uncertain`.

## Gateway {#gateway}

Phone access is `bounded-read-routes`. Tailscale Serve is `tailnet-admission-not-approval`. Passkeys are `webauthn-linux-verification`. ControlPlane mints `controlplane-receipt-once`.

## Owner gates {#gates}

- `production-activation-gate` = `JARVIS_PRODUCTION_ACTIVATION_APPROVAL`
- `vault-transfer-gate` = `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL`
- `production-restore-gate` = `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL`
- Task 36: `systemd-runtime-skipped`
- Mac/phone real surfaces: `device-observation-separate`

Packaging for the Mac Electron client is documented in `mac-client-packaging.md` and is not an authority procedure.

## Live authority and dashboard {#live-bootstrap}

Read-only observation on 2026-09-08T06:06:31Z supersedes the earlier bootstrap-worktree description.
`systemctl --user show` and each process's `/proc/<pid>/cwd` agreed on these locations. Start tokens
were unchanged before/after the directory read. This observation did not change or restart either unit.

| Unit | Observed state/PID | WorkingDirectory | Resolved release directory |
|---|---|---|---|
| `jm-jarvis.service` | active/running, 2123274 | `~/.local/state/orca-jarvis/authority/current` | `authority/releases/a3cbbbe1604798052db6051a8751f039573eb126` |
| `jm-jarvis-dashboard.service` | active/running, 1625716 | `~/.local/state/orca-jarvis/control-center/current` | `control-center/releases/artifact-4146a192b5fb9e489e2ce3fcb9629077739df0134bc26094750628369dcfdb98` |

Release directories above are relative to `/home/jm/.local/state/orca-jarvis/`.
Authority start: 2026-09-03 23:52:19 KST; dashboard start: 2026-09-07 16:41:56 KST.
Neither directory contained `dist/build-metadata.json`. Directory names and the developer checkout
do not prove the build loaded into either process or business readiness.

Operating migration/activation remains on HOLD: the journal has one unexpected historical entry.
See [the release/schema comparison and isolated-copy rehearsal](../planning/daemon-operating-rehearsal-2026-09-08.md).
Production changes still require the applicable owner gate and operator instruction.

Historical Task 36 used `jm-jarvis-24x7-bootstrap` and the boundary
`live-bootstrap-execstart-out-of-scope`; that describes the earlier rehearsal, not today's live path.
