> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# deploy/ — host-absolute user systemd units

Score 6 (21 units; distinct from `ops/` publish scripts and from `src/`). `src/` does not import this tree.

## OVERVIEW
User-manager units for the Linux authority host. Paths are absolute, not rendered templates. A unit file on disk is not proof the unit is active.

## WHERE TO LOOK
| Unit | Entry |
|------|-------|
| `jm-jarvis.service` | `cli.js db migrate` then `service run`; drop-in `jm-jarvis.service.d/10-orca-integration.conf` |
| `jm-jarvis-dashboard.service` | `dashboard/main.js` on `127.0.0.1:4173` |
| `jm-jarvis-phone-gateway.service` | `127.0.0.1:4176`, upstream `4173`; `Requires=` dashboard |
| `jm-jarvis-phone-gateway-serve.json` | Tailscale serve HTTPS 8444; `funnel: false`; tailnet-only |
| `jm-jarvis-morning.timer` | `07:15:00 Asia/Seoul`; candidate, operator activation required |
| `jm-jarvis-evening.timer` | `21:30:00 Asia/Seoul` plus evening PEM; candidate |
| `jm-jarvis-backup.timer` | `personal-os-backup-cli.js --production` every 15 minutes |
| `jm-jarvis-portfolio-*.timer` | collector spool via `orca-ide`; ingest is a separate authority-cwd unit |
| `jm-second-brain-*.timer` / `.path` | sibling state tree; refresh entrypoint comes from an env file |

## CONVENTIONS
- Node pin in units: `/home/jm/.nvm/versions/node/v24.19.0/bin/node`. DB: `/home/jm/.local/state/orca-jarvis/jarvis.sqlite`.
- Authority cwd is `authority/current`; dashboard, phone, and collector cwd is `control-center/current`.
- Hardening is the default: `UMask=0077`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`. Dashboard, authority, and phone also deny non-localhost IP.
- Install targets are `default.target`, `timers.target`, `paths.target`. Clocks are fixed `Asia/Seoul` `OnCalendar`, not UTC.
- Second Brain request apply fires only when `requests/pending` is non-empty and `request-executor.enabled` exists.

## ANTI-PATTERNS
- Do not `systemctl` start, restart, or switch `current` from this tree without an explicit operator instruction.
- Do not treat morning/evening descriptions as activated timers.
- Do not point `ExecStart` at the git checkout. Units call the `current` release.
- Do not copy `docs/historical/` LaunchAgents as the Linux procedure.
