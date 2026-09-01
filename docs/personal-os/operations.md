# Personal OS operations (Linux authority)

Machine facts for operators. Executable production steps require the named owner gates. Task 36 does not activate production.

## Host {#host}

- Authority and scheduling: `linux-authority` `linux-scheduler`
- Second Brain effects: `provider-owned-effects`
- Mac/phone: `mac-client-only`

## Units {#units}

`jarvis-owner`: `jm-jarvis.service` `jm-jarvis-dashboard.service` `jm-jarvis-phone-gateway.service` `jm-jarvis-backup.service` `jm-jarvis-backup.timer` `jm-jarvis-portfolio-collector.service` `jm-jarvis-portfolio-collector.timer`

`provider-owner`: `jm-second-brain-refresh.service` `jm-second-brain-refresh.timer` `jm-second-brain-requests.service` `jm-second-brain-requests.path` `jm-second-brain-backup.service` `jm-second-brain-backup.timer`

## Schedule {#schedule}

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

## Live bootstrap unit {#live-bootstrap}

Live `jm-jarvis.service` currently uses worktree `jm-jarvis-24x7-bootstrap` as `WorkingDirectory` / `ExecStart`. Changing that live ExecStart is `live-bootstrap-execstart-out-of-scope` production mutation. Task 36 rehearses the `authority/current` topology in committed `deploy/jm-jarvis.service` only and does not rewrite, enable, start, or restart the live unit.

