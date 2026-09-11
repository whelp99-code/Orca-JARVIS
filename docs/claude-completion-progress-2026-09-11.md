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
| M4-second-brain | IN_PROGRESS | 조사 완료 | `src/cli-evening-inputs.ts:34-35`(null reader), `docs/planning/daily-refresh-publication-contract.md` | 최신 계약 실연동 또는 §8.4 산출물 | 실측: provider refresh receipt 스키마 미합의(문서 36-37행), 관련 스키마/프로필 검색 매치 0. 설치물은 실재(`releases/41f0751a…`, `bin/second-brain-mcp`·`bin/sb` 실행 가능) | JARVIS측 fail-closed `RefreshCompletionReader` adapter·버전 협상·제품 상태 연결·계약 회귀 구현 | provider 계약 합의 |
| M4.2-lineage | TODO | — | `docs/planning/task-memory-source-privacy-hold.md` | 출처·동의·삭제 전파 | 재확인: provider에 `source_lineage`/`task_lineage`/`completion_id` 부재(문서 79-86행) | 두 P1 구현 | provider lineage 계약 |
| M5-work | IN_PROGRESS | 조사 완료 | `src/task-executor-registry.ts:12,74-80`, `src/task-execution-runtime.ts:24-28` | 실행 증거 또는 준비된 적용안 | 실측: 환경변수 3개 모두 미설정(값 미출력) → `TASK_EXECUTOR_CONFIGURATION_MISSING`으로 fail-closed. 승인→실행→검증→완료 회귀는 존재하나 전부 fixture 키·mock provider·주입 시계 | 설정 manifest·구체 업무안·적용/rollback 절차 문서 작성 | 실행자 인증 |
| M6-integration | VERIFIED | `0d6d614` | 전체 verify·패키지·HTTP probe | §11 종료 조건 | verify RC 0, 592파일/4,093테스트, 입력 digest 전후 동일; 패키지 integrity matched, `deployment_ready=false`; migration 배포분 변경 0 | 최종 회신서 제출 | 독립 리뷰 not_performed |

## 증거 경로

- private QA root: `/home/jm/.cache/jarvis-m6-20260911` (최종 manifest `final-manifest.json`), 단위 증거 `/home/jm/.cache/jarvis-m2-20260911`, 초기 `/home/jm/.cache/jarvis-m1-exact-20260911`
- 리뷰 원본 증거(변경 금지): `/home/jm/.cache/jarvis-r2-exact-review-20260911`, `/home/jm/.cache/jarvis-r2-copy-review-20260911`, `/home/jm/.cache/jarvis-final-review-20260911`, `/home/jm/.cache/jarvis-opus-review-20260910`
- 과거 gate 로그·receipt: `/home/jm/.cache/jarvis-lineage-qa`

## 운영 경계

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제는 하지 않는다. 이 원장은 개발 범위의 진행만 기록한다.
