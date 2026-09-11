# 완료 작업 진행 원장 — 2026-09-11

`docs/claude-completion-instructions-2026-09-11.md`의 M0–M6을 수행하는 단일 재개 기준 문서다. 세션이 끊기면 이 원장을 먼저 읽고 이어간다. 기존 진행 문서(`docs/opus-fix-final-reply-2026-09-11.md` 등)는 덮어쓰지 않는다.

상태 값: `TODO`, `IN_PROGRESS`, `VERIFIED`, `EXTERNAL_BLOCKED`. 테스트 미작성·내부 결함·검증 실패·패키지 미생성은 외부 차단이 아니다.

## M0 기준 (실측)

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| M0 시점 HEAD | `082d689786970bc307a718d0cddf6f4fb2c9bf2e` (tree `61210bffd30ad0d6b428ae6e73456ac70464538d`) |
| tracking branch | `not_configured` (ahead/behind 측정 불가) |
| M0 시점 tracked 변경 | M 4 (`src/local-observation-retention-candidate.ts`, `src/local-observation-retention-selection.ts`, `src/local-observation-retention.ts`, `tests/integration/local-observation-retention-consistency.test.ts`), D 0 |
| M0 시점 untracked | `.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules` (도구 상태·공유 의존성, 커밋 대상 아님) |
| toolchain | Node `v24.19.0`, npm `12.0.2` |
| scratch | `/home/jm/.cache` (vda2, 664G 여유). private QA root `/home/jm/.cache/jarvis-m1-exact-20260911` |
| 자체 verify 실행 | 없음 (이 checkout 기준). 다른 프로젝트(mail-intelligence 등)의 장기 실행은 이 입력과 무관 |
| migration 해시 벡터 | 95개 파일, `migration-hash-vector.json`, 벡터 digest `94d414c32c648cc6…` |

직전 전체 gate의 범위(지시서 §2.1)는 제품 `61d6de1`이며, 그 이후 제품 코드가 바뀌었으므로 그 결과를 현재 트리에 소급하지 않는다.

## 단위 원장

| 단위 ID | 상태 | 근거 SHA | 파일·계약 | 인수 항목 | 실행 결과와 receipt | 다음 동작 | 외부 의존성 |
|---|---|---|---|---|---|---|---|
| M0-baseline | VERIFIED | `082d689` | 위 표, `migration-hash-vector.json` | 트리·도구·scratch·실행 중 gate 확인 | 이 문서의 M0 표 | M1 진행 | 없음 |
| M1-P1A-audit | VERIFIED | `92e2e5a` | `local-observation-retention*.ts` | 차단 context를 인용한 감사 행 보존 | `local-observation-retention-plan.test.ts` 11/11 (감사 행 3 유지, 2로 줄인 후보 거절) | M2로 진행 | 없음 |
| M1-P1B-values | VERIFIED | `92e2e5a` | 같은 모듈 | 값·열 경계 구분 | 같은 파일의 값 구별 7 케이스 통과 (구분자·인용·빈 문자열·NULL·blob·수치·큰 정수) | M2로 진행 | 없음 |
| M1-shared-plan | VERIFIED | `92e2e5a` | `memory-authority-fresh-builder.ts`(copyExpression/copyFilter/tableColumns export), `memory-compaction-sanitize.ts`(suppressedRowMutations export), `local-observation-retention-candidate.ts` | 복사기·정제기 규칙을 검증기가 그대로 사용, 양방향 비교 | retention 4개 suite 52/53 통과 후 잔여 1건은 5s 기본 타임아웃 초과로 판명, 명시 타임아웃 부여 후 24/24 | M2로 진행 | 없음 |
| M2-recovery | VERIFIED | 이 커밋 | `local-observation-retention-operation.ts`, `-recovery.ts`, `-swap.ts`, `migrations/089` | claim 후·복사 중·검증 후·교체 직전·교체 직후 5개 지점에서 실제 child process 강제 종료 후 복구 | `local-observation-retention-recovery.test.ts` 6/6 (stdout 센티널 배리어, sleep 없음) | M3 진행 | 없음 |
| M2-schedule | VERIFIED | 이 커밋 | `local-observation-retention-service.ts`, `migrations/090`, `scripts/measure-local-retention-capacity.mjs`, `docs/local-retention-operations-proposal.md` | 무설정=inactive, runtime 없음=unsupported, 창 밖=deferred, 미완료=blocked; 뒤로 간 시계·장기 공백 | `local-observation-retention-schedule.test.ts` 5/5; 4주기 실측 capacity.json | M3 진행 | 운영 적용은 운영자 결정 |
| M3-citation-contract | VERIFIED | 이 커밋 | `src/personal-context-citation-contract.ts` | assembler 출력 증거 kind와 추천 인용 계약의 차이를 출처 기반으로 결속, advisory 로컬 관측 미승격, `owner_decision` 생성 불가 | `local-observation-citation-contract.test.ts` 3/3 | M3 나머지 | 없음 |
| M3-producer | IN_PROGRESS | 이 커밋 | assembler→추천→brief | fixture 수동 삽입 없는 actionable 경로 | 계약 격차는 해소. 실제 actionable 추천은 owner decision 또는 verified live Linux 출처가 필요하며 advisory 로컬 체인만으로는 성립하지 않음(설계상 정확한 거절) | 남은 항목은 최종 회신서에 정확히 기술 | owner decision 표면/실제 live adapter |
| M4-refresh-adapter | VERIFIED | 이 커밋 | `src/second-brain-refresh-receipt.ts`, `src/cli-daily-commands.ts`, `src/cli-evening-inputs.ts`, `src/daily-loop-usage.ts`, `docs/claude-second-brain-contract-handoff-2026-09-11.md` | 버전 협상·fail-closed 파서·거절 사유 기록·제품 상태 연결 | `second-brain-refresh-receipt.test.ts` 6/6; daily 회귀 5파일/35테스트; `provider_refresh`가 상수에서 저장된 `refresh_context` 단계 기반으로 전환 | provider가 §3.2를 발행하면 인계 문서 §5 절차 실행 | provider receipt 발행 |
| M4.2-binding | VERIFIED | 이 커밋 | `migrations/091_memory_candidate_task_sources.sql`, `src/memory-candidate-task-source.ts`, `src/cli-memory-intake.ts`, `src/cli-runtime.mts`, `src/dashboard/memory-candidate-review.ts`, `src/second-brain-write-authority.ts` | 원본 task 결속과 접수·검토·쓰기 3지점 차단 전파 | `memory-candidate-task-source.test.ts` 4/4; 인접 memory 회귀 3파일/25테스트 | 저장 후 삭제 전파·복원 재유입·2클라이언트 확인 | provider lineage 계약(2클라이언트 부분) |
| M4.2-rebuild-restore | VERIFIED | 이 커밋 | `tests/integration/memory-candidate-task-source.test.ts` | rebuild 시 결속 동반 제거, 백업 복원 후 재유입 0 | 6/6. 차단된 후보의 결속은 복사기의 `candidate_id` 일반 규칙으로 제외되며(정제기 별도 규칙 불필요, 실측으로 확인), 백업 이후 숨긴 task는 복원본에서도 숨겨진 채 검토 `undefined` | 저장된 파생 기억 철회만 남음 | — |
| M4.2-withdrawal-list | VERIFIED | 이 커밋 | `src/memory-candidate-task-source.ts` (`memoriesAwaitingTaskWithdrawal`) | 숨긴 task가 provider에 남긴 저장분 열거 | 7/7. 보이는 task는 0건, 숨기면 candidate·task·content digest로 1건, 결속 없는 DB는 0건. 저장분 매칭은 복원 경로와 같은 content identity 기준 | 각 항목이 철회가 지목할 resolved target(`target_id`/`target_digest`)을 함께 싣고, 아직 저장되지 않았으면 null. 소유자 승인 경로가 suppression을 쓰면 목록이 비워짐 | 소유자 승인·provider |
| M4.2-prepared-approval | VERIFIED | 이 커밋 | `src/dashboard/memory-candidate-decision-staging.ts` | 후보 생성 뒤 원본을 숨겼을 때 **이미 준비된 승인 명령**의 확정 차단 | 8/8. 확인 방법: 검사를 빼면 이 회귀가 실패함(실측). 기존 `requireVisible`은 후보 자체의 차단만 보고 원본 task 차단은 보지 않았음 | — | — |
| M4.2-withdrawal-effect | TODO | — | 승인 기반 실제 철회 실행 | 저장분 제거 | 미착수. `MemoryDeletionStore.request()`의 입력 벡터는 확인했고 target 식별자는 목록이 제공하지만, `scope_digest`·`payload_digest`·spool 값은 effect V2 계약에서 생성해야 하며 suppression 기록은 tombstone chain에 결속된 소유자 승인 산출물이다 | 승인 경로와 함께 구현 | 소유자 승인·provider |
| M4.2-project-scope | TODO | — | `src/memory-candidate-policy.ts` | 제외 프로젝트 범위 검사(접수·소비 양쪽) | 실측: 후보 정책·후보 모듈 전체에 `project`/`exclude` 개념이 없음(`grep` 매치 0). config에도 제외 목록 없음 | 정책 계약에 범위 필드를 추가하는 설계부터 | — |
| M5-readiness | VERIFIED | 이 커밋 | `docs/claude-task-execution-readiness-2026-09-11.md` | 설정 manifest·preflight 실측·업무안·적용/rollback 절차 | 실측 `routing probe-runtime claude-code`: `configuration=missing`, 없는 키 3개, `execution_available=false`, `readiness=not_probed`, `TASK_AUTH_PROBE_NOT_CONFIGURED` (값 미출력, 로그 `executor-readiness.log`) | 운영자가 service 환경에 3개 키 설정 후 문서 §5–6 실행 | 실행자 인증 |
| M5-execution | EXTERNAL_BLOCKED | — | 실제 승인 업무 1건 | 승인→실행→서명 검증→완료 receipt | 미실행. 현재 상태에서 `TASK_EXECUTION_NOT_CONFIGURED`로 fail-closed | 인증 제공 후 재개 | 실행자 인증 |
| M6-integration | VERIFIED | `0d6d614` | 전체 verify·패키지·HTTP probe | §11 종료 조건 | verify RC 0, 592파일/4,093테스트, 입력 digest 전후 동일; 패키지 integrity matched, `deployment_ready=false`; migration 배포분 변경 0 | 최종 회신서 제출 | 독립 리뷰 not_performed |

## 증거 경로

- private QA root: `/home/jm/.cache/jarvis-m6-20260911` (최종 manifest `final-manifest.json`), 단위 증거 `/home/jm/.cache/jarvis-m2-20260911`, 초기 `/home/jm/.cache/jarvis-m1-exact-20260911`
- 리뷰 원본 증거(변경 금지): `/home/jm/.cache/jarvis-r2-exact-review-20260911`, `/home/jm/.cache/jarvis-r2-copy-review-20260911`, `/home/jm/.cache/jarvis-final-review-20260911`, `/home/jm/.cache/jarvis-opus-review-20260910`
- 과거 gate 로그·receipt: `/home/jm/.cache/jarvis-lineage-qa`

## 운영 경계

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제는 하지 않는다. 이 원장은 개발 범위의 진행만 기록한다.
