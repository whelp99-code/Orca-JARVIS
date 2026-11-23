> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# docs/ — decision records and one Linux procedure

Score 6 (244 files; five subtrees). Earned a file because prose here is not source and is easy to treat as current.

## OVERVIEW
Markdown contracts, handoffs, and ADRs. Only `personal-os/release.md` is the executable Linux procedure. A dated APPROVE applies to the tree that was measured.

## WHERE TO LOOK
| Tree | Role |
|------|------|
| `personal-os/` | Linux release procedure; see that directory's AGENTS.md |
| `planning/` | ADR / intake notes; see that directory's AGENTS.md |
| `core5/` | mail-draft integration; `CORE5_INTEGRATION_ENABLED` default off; `mail.send` unregistered |
| `historical/` | Mac LaunchAgents marked `HISTORICAL_NON_EXECUTABLE` |
| `adr/` | one accepted-not-adopted DBOS comparison |
| flat `*.md` | handoffs and ledgers; newer judgment blocks supersede older tables |

## CONVENTIONS
- Linux is the only authority host. `local` means `linux-control-plane`. Mac is client or QA evidence.
- Ledger blocks are append-only. Do not rewrite an old row to `VERIFIED`.
- `core5-k01-baseline.json` is a locked read-only baseline. Do not refresh it by fetching remotes.
- `docs/core5/k03-oss-lock.json` records `production_engine_change: false`. Proposed tools there are not installed.

## ANTI-PATTERNS
- Do not `launchctl` bootstrap, bootout, or kickstart `historical/mac-launchagents/`.
- Do not install ClamAV, Docling, OpenTelemetry, or DBOS, and do not add a direct `jose` dependency.
- Do not register `mail.send` or treat UI/card state as authority.
- Do not read `CONTROL_TOWER.md` or a 2026-09 handoff as the live command contract.
- `PROJECT_INVENTORY.md` at repo root is stale; this tree does not replace it.
