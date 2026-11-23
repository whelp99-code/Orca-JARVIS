> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# docs/planning/ — ADR notes, not activation records

Score 4 (124 Markdown files; distinct decision-record domain). Parent docs index this tree; this file is the reading rule.

## OVERVIEW
Decision records, mostly 2026-09-08/09. Implemented-in-isolation is not operational activation. Several notes stay HOLD until a named contract is solved.

## WHERE TO LOOK
| Cluster | Files | Rule |
|---------|-------|------|
| Intake | `00-INTAKE.md`, `01-DISCOVERY-BASELINE.md`, `04-RISKS.md` | proposals stay read-only; lost ack stays `uncertain` |
| Capability / team | `02-REQUIREMENTS-ACCEPTANCE.md`, `03-ARCHITECTURE-CONTRACTS.md`, `05-PR-PLAN.md` | matrix writes nothing; proposals are not receipts |
| Daily loop | `adr-daily-*`, `adr-native-evening-*`, `adr-morning-systemd.md` | consume stored sources; parser checks are not systemd activation |
| Timeline / lineage | `adr-timeline-*`, `adr-*-lineage.md`, `adr-mixed-parent-producers.md` | first emission wins; do not bypass quarantine |
| Retention | `adr-retention-*`, `retention-operation-directory-design.md` | cutoff fixed at job creation; the design note is unimplemented |
| Build identity | `adr-backend-build-identity.md`, `adr-daemon-runtime-identity.md` | manifest last; lease+process start, not Git HEAD alone |

## CONVENTIONS
- Wire examples stay `schema_version: 1` and snake_case. Capability stages are monotonic.
- Seoul calendar for priority `today`; daily loop clocks are 07:15 and 21:30 `Asia/Seoul`.
- Closeout trust is an external key, not the key inside the envelope.
- Dashboard policy is fixed at startup from build assets, not cwd.

## ANTI-PATTERNS
- Do not treat a unit test or a parser check as a production connector or an enabled timer.
- Routing labels never become command strings or paths.
- Do not auto-retry a potentially incurred provider call.
- Do not relabel already approved or completed work. A missing retired payload is not absence.
- Executor probe never substitutes for execution preflight and never invokes a model prompt.
