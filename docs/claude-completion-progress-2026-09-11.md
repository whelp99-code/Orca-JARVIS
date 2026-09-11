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
| M4.2-withdrawal-effect | EXTERNAL_BLOCKED | — | 승인 기반 실제 철회 실행 | 저장분 제거 | 준비 지점은 `MemoryDeletionSaga.prepare()`이고 소유자 승인용 명령을 반환한다. 그 입력 `ResolvedMemoryTargetV2`가 요구하는 `vault_head`/`vault_tree`/`page_id`/`page_blob_oid`/citation span/`valid_from`/`valid_until`이 authority DB에 **없다**(필드 대조표는 planning 문서). provider 재해석이 선행돼야 함 | provider 재해석 계약 합의 후 어댑터 구현 | provider 재해석·소유자 승인 |
| M4.2-project-scope | TODO | — | `src/memory-candidate-policy.ts` | 제외 프로젝트 범위 검사(접수·소비 양쪽) | 실측: 후보 정책·후보 모듈 전체에 `project`/`exclude` 개념이 없음(`grep` 매치 0). config에도 제외 목록 없음 | 정책 계약에 범위 필드를 추가하는 설계부터. 선택지 3개와 각각의 파급을 planning 문서에 기록 | 프로젝트 정체성 위치 결정 |
| M5-readiness | VERIFIED | 이 커밋 | `docs/claude-task-execution-readiness-2026-09-11.md` | 설정 manifest·preflight 실측·업무안·적용/rollback 절차 | 실측 `routing probe-runtime claude-code`: `configuration=missing`, 없는 키 3개, `execution_available=false`, `readiness=not_probed`, `TASK_AUTH_PROBE_NOT_CONFIGURED` (값 미출력, 로그 `executor-readiness.log`) | 운영자가 service 환경에 3개 키 설정 후 문서 §5–6 실행 | 실행자 인증 |
| M5-execution | EXTERNAL_BLOCKED | — | 실제 승인 업무 1건 | 승인→실행→서명 검증→완료 receipt | 미실행. 현재 상태에서 `TASK_EXECUTION_NOT_CONFIGURED`로 fail-closed | 인증 제공 후 재개 | 실행자 인증 |
| M6-integration | VERIFIED | `0d6d614` | 전체 verify·패키지·HTTP probe | §11 종료 조건 | verify RC 0, 592파일/4,093테스트, 입력 digest 전후 동일; 패키지 integrity matched, `deployment_ready=false`; migration 배포분 변경 0 | 최종 회신서 제출 | 독립 리뷰 not_performed |

## 증거 경로

- private QA root: `/home/jm/.cache/jarvis-m6-20260911` (최종 manifest `final-manifest.json`), 단위 증거 `/home/jm/.cache/jarvis-m2-20260911`, 초기 `/home/jm/.cache/jarvis-m1-exact-20260911`
- 리뷰 원본 증거(변경 금지): `/home/jm/.cache/jarvis-r2-exact-review-20260911`, `/home/jm/.cache/jarvis-r2-copy-review-20260911`, `/home/jm/.cache/jarvis-final-review-20260911`, `/home/jm/.cache/jarvis-opus-review-20260910`
- 과거 gate 로그·receipt: `/home/jm/.cache/jarvis-lineage-qa`

## 운영 경계

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제는 하지 않는다. 이 원장은 개발 범위의 진행만 기록한다.

## 독립 리뷰 지적 처리 (2026-09-11)

다른 모델(GPT-5.6)의 독립 리뷰가 `082d689..HEAD` 제품 diff에서 **CHANGES_REQUIRED**와 함께 P1 7건·P2 1건·P3 1건을 재현 코드와 함께 제기했다. 재현 스크립트는 `/home/jm/.cache/jarvis-indep-review-20260911/*.mjs`.

| 지적 | 상태 | 처리 |
|---|---|---|
| P3 routing CLI가 5번째 위치 인자를 조용히 수용 | 수정 | 내가 넓힌 가드는 memory가 아니라 **routing** 블록이었다. `=== 4`로 복구. memory의 5번째 인자는 `cli-control-commands.ts:28` 경유라 원래부터 동작 |
| P1 숨긴 task 접수가 unbound 후보를 커밋 | 수정 | 결속을 `MemoryCandidateStore.classify`의 **같은 트랜잭션**으로 이동. 리뷰어 재현 결과가 `rows:[] bindings:[] reviewFiles:[] visible:false`로 바뀜 |
| P1 준비된 승인이 receipt 적용에서 통과 | 수정 | `MemorySurfaceAuthority.applyCandidateReceipt`에 task 차단 재검사 추가. 리뷰어 재현이 `MEMORY_CANDIDATE_SUPPRESSED`로 거절되고 발행 0 |
| P2 복구가 일정 창에 가려짐 | 수정 | 복구를 fence claim **이전**으로 이동. `deferred`도 `recovered`를 함께 보고 |
| P1 안전하지 않은 정수 row key 충돌 | 수정 | 비교 양쪽을 safe integer로 읽음. 재현이 `accepted:false`로 뒤집힘. 실제 INTEGER 열 회귀 추가(수정을 빼면 실패) |
| P1 검증 후 후보 변조 가능 | 수정 | migration 092에 `verified_digest` 추가, 설치 직전 재확인. 재현이 `LOCAL_RETENTION_CANDIDATE_MODIFIED`로 거절되고 라이브 내용은 원본 유지 |
| P1 최종 fence 이후 원본 쓰기 유실 | 수정 | 검사를 체크포인트 이후로 옮기고, 닫은 뒤 rename 직전까지 원본 바이트·sidecar 유무를 재확인. 재현이 `lateRows:0`(유실) → `lateRows:1`(보존) + SOURCE_CHANGED로 뒤집힘 |
| P1 snapshot 경로 미소유·삭제 | 수정 | snapshot도 배타 확보, 실패 시 남의 파일 보존·자기 후보 회수. 재현이 `snapshotExists:true, candidateExists:false`로 뒤집힘. 연쇄로 드러난 sidecar 잔류(재시도 영구 차단)도 소유 증거 기반으로 정리 |
| P1 복구의 경로 기반 TOCTOU·sidecar 미확인 | 수정 | 원자적으로 옮긴 뒤 옮긴 객체를 확인하고 삭제. 우리 것이 아니면 되돌리고 `retained_unproven`. sidecar는 배타 확보된 이름 공간이라는 근거를 명시하고 개별 식별·전용 디렉터리 격리는 후속으로 기록 |

## 2차 독립 리뷰 (2026-09-11)

같은 방식으로 **수정 자체**를 다른 모델에게 다시 읽혔다(`e53c857~1..HEAD`). 판정 **CHANGES_REQUIRED**,
P1 6건·P2 3건. 재현은 `/home/jm/.cache/jarvis-indep-review2-20260911/*.mjs`.

| 지적 | 상태 | 근거 |
|---|---|---|
| INTEGER와 REAL이 같은 키 | 수정 | 정수는 bigint로만 들어오므로 number는 항상 REAL로 태깅. 재현 `accepted:false` |
| generation 비교가 JSON 숫자 | 수정 | 정확 정수 읽기 + 타입 비교로 재작성 |
| 자동 publication이 task 차단 미검사 | 수정 | 재현 `published:false, ledgerRows:0` |
| legacy correction 승인·준비 우회 | 수정 | 재현 `MEMORY_CANDIDATE_SUPPRESSED`, 상태 불변 |
| `verified_digest` 가변 | 수정 | migration 093 단일 기록 트리거 + 회귀 |
| `.releasing` 이름 선점·덮어쓰기 | 수정 | 임의 1회용 이름(리뷰 도착 전 자체 발견) |
| 복구가 살아 있는 소유자 작업 파괴 | 수정 | migration 094 시작 토큰, 재현 `retained_active`·파일 생존 |
| 후보 digest 확인~rename 창 | **열림** | 아래 |
| 원본 마지막 읽기~rename 창 | **열림** | 아래 |
| 운영 행 기록 이전 claim 유실 | **열림** | 아래 |
| `.releasing` 중 크래시 고아 | **열림** | 아래 |

### 남은 4건은 하나의 설계 문제다

네 건 모두 **산출물이 공유 이름 공간에 있고 교체 구간에 프로세스 간 배타성이 없다**는 같은 뿌리에서
나온다. 리뷰어의 처방도 하나다: **운영 전용 비공개 디렉터리 + 프로세스 간 swap/rebuild lease**.

- 비공개 디렉터리(생성 자체가 배타적)는 남의 파일이 우리 산출물 자리에 있을 수 없게 만들어 snapshot
  정리와 `.releasing` 계열 문제를 없앤다. 고정 부모 아래 두면 복구가 열거해 **행 없는 디렉터리**를
  발견할 수 있으므로 운영 행 이전 claim 유실도 보고 가능해진다.
- swap lease는 최종 읽기와 rename 사이에 다른 writer가 커밋하지 못하게 한다. 바이트 비교로는 닫히지
  않는다는 리뷰어 지적이 옳다.

이 변경은 `applyLocalObservationRetention`의 경로 계약과 복구·교체·일정 서비스, 그리고 관련 회귀
전반을 함께 바꾼다. 절반만 적용하면 같은 계열의 결함을 남긴 채 겉보기만 달라지므로, **독립된 단위로
설계·구현·재리뷰**하는 것을 전제로 여기서 멈추고 범위를 고정한다.


## 복구 세션 CODEX-JARVIS-RECOVERY-20260911-02 (2026-09-11)

이전 세션은 코드 완료가 아니라 대화 컨텍스트 초과로 멈췄다. 제품 트리는 보존된 채 이어받았고,
시작 시점 실측은 branch `codex/routing-approval-ui`, HEAD `49783df`, tracked M 5 / D 0, untracked
`migrations/095`·`migrations/096`·`docs/codex-opus-claim-followup-2026-09-11.md` 및 도구 상태였다.

### 실행 환경 결함 (제품 결함 아님)

지시서 §10.4가 예고한 `/tmp` usrquota 문제가 실제로 재현됐다. `/tmp` tmpfs 81% 사용(49G/61G)에서
vitest 워커가 `Unknown system error -122`(EDQUOT)로 7개 파일 전부 collection 실패했다. 이후 모든
실행은 `TMPDIR=/home/jm/.cache/jarvis-codex-claim-review-20260911-4ztfcjp6/monitor-repair-20260911/qa/tmp`
로 고정한다. 또한 vitest 위치 인자는 glob이 아니라 substring filter이므로 glob을 넘기면 "No test
files found"로 RC 1이 된다. 두 사실은 실패 집계에서 제품 결함과 분리한다.

### 인계된 실패 4건의 실제 원인과 처리

baseline `qa/retention-baseline.log`: 7파일 62테스트 중 4 failed / 58 passed.

| 실패 테스트 | 관측값 | 원인 | 처리 |
|---|---|---|---|
| `retention.test` "applies the selector through the rebuild adapter without writing the source" | expected 143 to be 140 | claim 대장(intent 기록 → identity 기록 → operation → intent 소멸 → verdict) 도입으로 source 쓰기가 2행에서 5행이 됐는데 단정은 이전 계약인 +2 | 계약을 +5로 갱신하고 `local_retention_claim_intents` 잔여 0을 함께 단정 |
| `retention.test` "does not remove a group the selector retained for a live notification" | expected 144 to be 141 | 같음 | 같음 |
| `retention-source-writes` "leaves the source untouched, logically and physically, while it copies" | expected 144 to be 141 | 같음 | 같음 |
| `retention-schedule` "holds the window against a duplicate start, a clock that went back and a long outage" | expected 'failed' to be 'processed' | **제품 결함**. `memory-authority-fresh-builder`가 모든 표를 무조건 복사하므로 `local_retention_claim_intents`가 candidate에 실려 교체 후 live authority에 남는다. 이 표의 `directory`는 UNIQUE이고 소유 프로세스는 이미 없으므로, 다음 주기의 intent INSERT가 죽은 행과 충돌해 `LOCAL_RETENTION_DESTINATION_INVALID`로 실패한다 | `copyFilter`에 `local_retention_claim_intents → WHERE 0`. 복사 계획을 그대로 재사용하는 `assertCandidateMatchesCopyPlan`도 같은 규칙을 보므로 검증기와 복사기가 어긋나지 않는다 |

검증: `qa/fix1.log` — 3파일 18테스트 전부 통과, RC 0 (선행 `npm run build` RC 0).

### 단위 원장 추가

| 단위 ID | 상태 | 파일·계약 | 인수 항목 | 실행 결과 |
|---|---|---|---|---|
| R02-claim-ledger-contract | VERIFIED | `local-observation-retention*.test.ts` | 확보 대장 도입 후 source 쓰기 계약을 정확히 5행으로 고정하고 intent 잔여 0 | fix1.log 18/18 |
| R02-intent-not-copied | VERIFIED | `memory-authority-fresh-builder.ts` | 교체된 authority가 죽은 claim을 상속하지 않고 다음 주기가 같은 경로를 다시 확보 | schedule 5/5 (7일 뒤 재기동 `processed`, operations 2행) |
| R02-swap-exclusivity | VERIFIED | `authority-database-swap-barrier.ts`(신규), `authority-db-base.ts`, `local-observation-retention-swap.ts`, `memory-authority-swap.ts`, `local-observation-retention-exclusivity.test.ts`(신규), `local-retention-writer-holder.mjs`(신규) | 아래 §배타성 | 아래 |

### 배타성(M2 §6.1-4, followup §4)의 실제 구현

2차 독립 리뷰가 남긴 4건의 공통 뿌리였던 "교체 구간에 프로세스 간 배타성이 없다"를 닫았다.
두 번째 authority/swap 체계를 만들지 않고, 이미 있는 세 가지를 결합했다: 모든 연결이 지나는 단일
open 경계(`AuthorityDbBase` 생성자와 `reopen()`), `/proc` 기반 open-inode 관측
(`discoverOpenInodeHolders`), 프로세스 레지스트리.

1. **배리어**: `<database>.swap-barrier`. 경로만으로 유도되므로 레지스트리 위치를 모르는 프로세스도
   찾을 수 있다. pid + start_token + reason을 담고, 소유자가 사라진 레코드는 debris로 취급해 제거한다.
   따라서 교체 중 급사가 DB를 영구히 잠그지 않는다.
2. **입장 통제**: open 경계에서 `assertSwapAdmission()`. 교체 중 새 연결은
   `AUTHORITY_DATABASE_SWAP_IN_PROGRESS`로 거절된다. 배리어 소유자 자신은 허용된다(자기 reopen).
3. **파괴 이전 거절**: retention 교체 순서를 checkpoint·fence 확인 → **배리어 공개(연결은 아직 열린
   상태)** → 1차 스캔(자기 pid를 제외한 holder가 있으면 `LOCAL_RETENTION_SOURCE_WRITER_ACTIVE`로
   즉시 거절) → close → sidecar 제거 → 2차 스캔(이제 자기 것까지 포함해 fd_count 0이어야 함) →
   applied 기록 → byte 재확인 → rename → reopen → 배리어 해제로 바꿨다. 공개가 스캔보다 먼저이므로
   스캔 이전에 열린 연결은 스캔이 보고, 스캔 이후의 연결은 입장 통제가 막는다. 이 순서가 "마지막
   검사 직후 커밋" 창을 닫는다.
4. **재시도 가능한 거절**: 1차 스캔이 연결을 닫기 전에 답하는 것은 편의가 아니라 필수다.
   `RetentionSourceFence.total_changes`는 연결 단위 카운터(`SELECT total_changes()`)라서
   `close()`/`reopen()`이 0으로 재시작시키고, 그러면 호출자가 들고 있던 fence가 이후 영구히
   "source가 움직였다"로 판정된다. 첫 구현은 close 뒤에 스캔을 두어 실제로 이 결함을 냈고, 격리
   회귀의 재시도 단계가 `LOCAL_RETENTION_SOURCE_CHANGED`로 실패했다. 계측으로
   `total_changes 143 → 0`을 실측한 뒤 순서를 바로잡았다. 지금은 거절이 아무것도 닫지 않고
   아무것도 쓰지 않으므로 writer가 사라진 뒤 같은 candidate로 재시도가 성립하며, 그 재시도까지
   회귀가 단정한다.
5. **공통 프로토콜**: 같은 배리어를 compaction 교체(`memory-authority-swap.ts`)에도 공개/해제한다.
   retention끼리만의 lock이 아니다. compaction의 기존 reader drain 계약
   (`MEMORY_OLD_DATABASE_FD_ACTIVE` 후 `recover`)은 의도적으로 바꾸지 않았다. 그것은 writer 배제가
   아니라 retired inode를 쥔 reader를 배수하는 별도 계약이고, 기존 인수 회귀가 그 동작을 고정한다.

회귀 `tests/integration/local-observation-retention-exclusivity.test.ts`는 셋 다 **실제 별도 프로세스**를
쓰고 sleep이 없다(자식의 stdout 라인과 exit 이벤트로만 동기화).

- 별도 프로세스가 실제 연결을 쥔 채 교체 시도 → 거절, source inode·행 수·candidate·배리어 파일이
  모두 보존됨을 단정. 자식이 연결을 놓은 뒤 같은 application으로 교체가 성공하고 관측 1건이 줄어든다.
- 배리어 유지 중 새 프로세스의 open → `AUTHORITY_DATABASE_SWAP_IN_PROGRESS`, 해제 후 open 성공.
- 배리어를 쥔 프로세스를 SIGKILL → 다음 open이 정상 허용되고 debris가 제거된다.

### 이 회귀가 수정을 실제로 고정한다는 근거 (변이 검사, 실측)

두 스캔을 `if (false)`로 바꾸고 같은 회귀를 실행하면 실패한다:

    × refuses to replace a source another process holds open, then swaps once it lets go
      → expected Error: LOCAL_RETENTION_OLD_DATABASE_FD_AC… to match { code: 'LOCAL_RETENTION_SOURCE_WRITER_ACTIVE' }

즉 수정이 없으면 교체가 그대로 진행되고 **원본을 잃은 뒤** old-fd를 발견해 오류를 낸다.
followup §4가 "데이터를 잃은 뒤 old-fd 발견/error 반환은 인수가 아니다"로 지목한 바로 그 동작이며,
회귀는 그 차이를 구분한다. 검사 후 원본 코드를 그대로 복원했다.

## TMPDIR 사실 정정 (실측)

`scripts/lib/test-environment.mjs`는 TMPDIR이 비어 있으면 스스로
`~/.cache/orca-jarvis/tests` 아래에 private scratch를 만들고 TMPDIR/TMP/TEMP를 거기로 덮어쓴다.
따라서 `npm test` / `npm run verify` 경로는 원래부터 /tmp 쿼터의 영향을 받지 않는다.
EDQUOT(-122)는 내가 `npx vitest`를 직접 호출해 `os.tmpdir()`가 /tmp로 해석된 경우에만
발생했다. 즉 이 장애는 **직접 호출 방식의 문제**이지 제품이나 공식 gate의 결함이 아니다.
`gui` 프로파일이 TMPDIR을 /tmp로 설정하는 곳은 bwrap 샌드박스 안의 private tmp를 /tmp에 bind한
경우라 공유 tmpfs와 무관하다.
