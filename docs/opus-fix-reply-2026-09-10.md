# R1–R4 수정 회신서 — 2026-09-10

## 판정

**R1·R2(P1) 두 결함은 수정했고, 리뷰의 재현 스크립트가 더 이상 재현하지 못한다. R3는 계약 정정과 측정으로, R4는 실제 자식 프로세스 인수와 범위 명시로 처리했다.** 운영 적용·교체·배포는 하지 않았다. `docs/opus-work-instructions-2026-09-10.md`의 순서를 따랐다.

## 대상과 식별

- worktree `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, branch `codex/routing-approval-ui`
- 시작 HEAD `5c99b27`, tracked 변경 0, untracked는 `node_modules`와 도구 상태 `.omo/ulw-loop/`뿐이었다.
- 기존 커밋 `5cd42a5`/`ba1d37e`/`9a9abdf`는 재작성하지 않았다. shipped migration은 수정하지 않았고 새 migration도 추가하지 않았다.

| R | 커밋 | 종류 |
|---|---|---|
| R1 | `7297671` | fix: 목적지 소유권 |
| R2 | `0197ce0` | fix: 선정–복사 일관성 |
| R3 | `3529ca6` | docs+test: 원본 쓰기 계약 정정과 측정 |
| R4 | `a9358d5` | test+docs: 실제 자식 프로세스 인수와 범위 |
| 리뷰 지적 대응 1차 | `72e85c0` | fix: fence를 복사 대상 파일에 고정, 모듈 분할, 매트릭스 보강 |
| 리뷰 지적 대응 2차 | `52db87d` | fix: 후보를 선정이 읽은 연결과 대조, 재시작·진짜 원본 부재 케이스 |

## R1 — 적용 목적지 소유권

원인은 두 겹이었다. `applyLocalObservationRetention`이 `freshPath === source.filename` 문자열만 비교했고, `buildFreshAuthority`가 목적지를 `rmSync(force)`로 지웠다. 문자열이 다르면 같은 파일이어도 통과했다.

수정: 적용 경로가 목적지의 real path를 해석해 원본 파일 자체를 거절하고, SQLite sidecar(`-wal`/`-shm`/`-journal`)가 이미 있는 이름을 거절하며, `O_EXCL`로 파일을 만들어 소유권을 선점한다. 그래서 같은 이름을 노린 두 번째 호출은 공유가 아니라 실패한다. `buildFreshAuthority`에는 명시적 목적지 모드를 넣었다. `replace`는 compaction·restore 호출자가 의존하던 기존 계약 그대로이고, `claimed`는 builder가 자기가 만들지 않은 경로를 절대 지우지 않는다. 실패 시 정리는 이 호출이 확보한 파일과 그 sidecar만 대상으로 한다.

인수(`tests/integration/local-observation-retention-destination.test.ts`, 3테스트):
- 원본 자신, `/./` 별칭, 정규화된 상대 경로, `process.cwd()` 기준 상대 경로, symlink 별칭 모두 `LOCAL_RETENTION_DESTINATION_INVALID`. 이후 원본 sha256과 sidecar 해시가 동일하고 새 연결로 열어 행 수까지 확인했다. symlink는 그대로 남는다.
- 기존 텍스트 파일·기존 DB·main 파일 없이 `-wal`만 남은 이름 모두 거절, 내용 보존.
- 같은 목적지를 노린 두 동시 호출은 정확히 1건만 성공(`fulfilled` 1 / `rejected` 1), 재구축본은 정상, 원본은 그대로.

공유 builder의 다른 호출자(`memory-authority-compactor.ts`, `memory-restore-high-water.ts`)는 기본값 `replace`라 계약이 바뀌지 않는다. 이를 회귀로 확인했다: builder에 도달하는 테스트를 모두 모아 **16파일/79테스트 통과(185초)**.

## R2 — 선정과 복사의 일관성

원인: `buildFreshAuthority`가 `await fresh.migrate()`에서 양보하므로, 선정 이후에 들어온 쓰기가 복사에는 포함된다. 리뷰 재현은 그 틈에 notification을 넣어 `recommendations=0`/`notification_intents=1`인 후보가 `foreign_key_errors=0`으로 성공 반환되는 것을 보였다.

수정:
- 적용은 선정 **전에** fence를 읽는다. fence는 이 연결의 `total_changes`(같은 연결의 DML)와 `data_version`(다른 연결의 커밋)이다. 빌드 후 fence를 다시 읽고 달라졌으면 후보를 `LOCAL_RETENTION_SOURCE_CHANGED`로 버린다.
- FK도 인덱스도 없는 `notification_intents.deep_link` 참조를 제거된 추천에 대해 검사해 `LOCAL_RETENTION_REFERENCE_DANGLING`을 낸다. 선정 이전부터 있던 알림은 selector가 그룹을 보존하므로, 이 검사에 걸리는 것은 선정 이후에 생긴 참조뿐이다.
- fence는 결과에 실려 나간다. `verifyLocalObservationRetentionCandidate(source, application)`가 교체 직전에 다시 확인하므로, 만들어진 뒤 원본이 움직인 후보는 적용되지 않는다.
- 거절된 후보는 sidecar와 함께 삭제한다. 중단된 적용이 “쓸 수 있는 후보”로 오인될 여지를 남기지 않는다.

인수(`tests/integration/local-observation-retention-consistency.test.ts`, 4테스트). 동시성은 sleep 없이 adapter 자신의 yield에서 구동한다.
- 같은 연결이 틈에 notification 삽입 → `LOCAL_RETENTION_SOURCE_CHANGED`, 후보 파일 없음, 원본 추천 1·알림 1·관측 1 유지.
- 두 번째 연결이 삽입 → 동일하게 거절.
- 손으로 만든 후보에서 `foreign_key_errors=0`인데도 dangling 참조를 정확히 찾아냄(보존된 그룹은 보고하지 않음).
- 정상 적용 직후 검증은 통과하고, 원본이 바뀐 뒤에는 `LOCAL_RETENTION_SOURCE_CHANGED`. 이때 후보 파일과 원본은 그대로다.

## R3 — 원본 쓰기 계약

`buildFreshAuthority`는 원본에 `wal_checkpoint(TRUNCATE)`를 실행한다. 동작을 바꾸지 않고 계약을 사실대로 고쳤고, 지표를 분리해 측정으로 고정했다(`tests/integration/local-observation-retention-source-writes.test.ts`).

측정: 미반영 WAL이 있는 격리 DB에서 적용 후 `total_changes()` 동일, 대상 6개 표의 논리 행 수 동일, main 파일 sha256 **변경**, WAL 크기 **0**, 새 연결 재오픈 시 내용 동일.

정확한 계약은 “교체 없음, 삭제 없음, 논리 변화 없음, 원본 WAL에 대한 유지보수 쓰기 있음”이다. `docs/cursor-handoff-continuation-2026-09-10.md`와 `docs/planning/local-timeline-daily-consumption.md`의 ‘원본 무기록’ 문장을 이 계약으로 교체했고, continuation 문서의 ‘retention이 계약만 있고 구현이 없다’ 행도 현재 구현(선정·적용·설정 표면)과 미구현(일정화·교체 프로토콜)으로 정정했다.

## R4 — 실제 프로세스와 producer 경계

`tests/integration/daily-morning-cli-process.test.ts`(3테스트)가 자식 프로세스로 검증한다. 모든 확인은 프로세스 종료 후 새 연결로 읽는다.

- 실제 제품 바이너리 `node dist/src/cli.js daily morning --once`: 사용 불가 설정에서 exit **2**, stderr `DAILY_LOOP_CONFIG_INVALID`, stdout 비어 있음, DB sha256 불변, `daily_loop_runs` 0.
- 제품 바이너리에는 clock 우회를 만들지 않았다. 고정 시각 케이스는 같은 dist 빌드를 실행하는 테스트 전용 진입점 `dist/tests/fixtures/compiled-daily-cli.js`로 돌린다. 발행(exit 0, `provider_refresh=unavailable`, `automatic_operation=hold`, `run.state=completed`, brief `ready`/`item_count=1`), 재실행 무중복(`completed_run_ids=[]`, run·reconcile·brief_id 동일), hold 시 기권(`item_count=0`, `abstention_reasons=["no_authoritative_data"]`).
- 임의 시각에 실제 바이너리를 그대로 돌리면 `DAILY_LOOP_MISSED_RECOVERY_WINDOW` exit 2다(실측). 아침 창이 07:15:00.000 KST 한 점이므로 고정 시각을 주입한 것이며 시계를 기다리거나 호스트 시계를 바꾸지 않았다.

**닫지 않은 것**: 이 체인은 여전히 `tests/fixtures/local-observation-chain.ts`가 `linux_live_fact`/`user_confirmed_principle`/`owner_decision`을 직접 구성한 증거다. 실제 assembler는 `context_observation`/`confirmed_memory`를 낸다. 따라서 fixture 체인이 brief에 도달한 것은 실제 producer 경로가 도달한 것이 아니다. 두 기록에 이 문장을 남겼고, evidence kind 문자열 치환이나 `sufficient` 강제로 잇지 않았다.

## 독립 게이트 리뷰와 그 결과

수정 뒤 별도 세션의 독립 리뷰어에게 네 커밋을 감사시켰고 **REJECT**를 받았다(보고서 `/home/jm/.cache/jarvis-lineage-qa/gate-review.md`). 지적 네 건 중 셋을 `72e85c0`으로 닫았고 하나는 남은 항목으로 명시한다.

| 지적 | 처리 |
|---|---|
| fence가 열린 연결의 카운터만 보므로, 원본 **경로가 통째로 교체되면** 선정과 복사가 다른 inode를 볼 수 있다 | fence에 device/inode를 추가했다. 경로 교체 인터리빙 테스트를 추가했고, 원본이 움직이는 중 실패한 빌드는 하위 증상 대신 `LOCAL_RETENTION_SOURCE_CHANGED`를 보고한다 |
| 인터리빙 매트릭스에 다른 연결의 context/replacement 삽입과 중단 후 미완성 후보 확인이 없다 | 두 번째 연결이 context 체인 전체를 추가하는 케이스를 넣었고, 경로 교체 케이스에서 후보와 sidecar가 하나도 남지 않음을 단정한다 |
| 기록은 WAL/SHM을 측정한다고 하는데 테스트는 `-wal`만 본다 | `-shm`도 측정하도록 테스트를 고쳤다(문구를 낮추지 않고 측정을 맞췄다) |
| 계획 문서에 "적용과 설정 표면 미구현" 문단이 남아 자기 문서와 모순된다 | 해당 문단을 현재 구현(적용·설정 구현, 일정화·교체 미구현)으로 정정했다 |
| §4 프로세스 매트릭스에 replacement·만료·원본 부재·capped가 없다 | 만료·정리된 snapshot·대체 소스를 먼저 추가했고, 이후 진짜 원본 부재와 **capped**까지 넣어 매트릭스를 닫았다(프로세스 테스트 8/8) |

리뷰가 실제로 잡아낸 회귀가 하나 더 있었다. 전체 verify 1차 실행에서 `task12-runtime-reviewability`와 `personal-context-remediation`이 실패했다. `src/local-observation-retention.ts`가 비어있지 않은 줄 256(한도 250)을 넘겼기 때문이다. 선정·설정을 `src/local-observation-retention-selection.ts`로 분리하고 후보 수명주기를 원래 경로에 남겨 두 테스트를 통과시켰다. 분리 직후 리뷰어가 리포 지표로 실측한 값은 각각 128줄과 154줄이었다(내 커밋 메시지의 134줄은 부정확했다). 2차 대응까지 반영한 현재 값은 200줄과 128줄로 둘 다 한도 250 아래다. 원래 경로를 유지한 이유는 리뷰의 `reproduce.mjs`가 `dist/src/local-observation-retention.js`에서 `applyLocalObservationRetention`을 import하기 때문이다.

### 2차 재감사와 대응

1차 대응(`72e85c0`)을 같은 리뷰어에게 다시 감사시켰다. SHM 측정·계획 문서 모순·모듈 분할/임포트는 APPROVE, 세 건은 다시 REJECT였고 그중 둘을 `52db87d`로 닫았다.

| 재감사 지적 | 처리 |
|---|---|
| device/inode는 **현재 경로**를 식별할 뿐이다. apply 시작 **전에** 경로가 교체돼 있으면 두 fence 판독 모두 새 inode를 보고, 선정은 열린 연결의 옛 inode를 읽는다 | 후보를 선정이 사용한 연결과 대조한다. 선정이 바꿀 수 있는 표는 차단한 만큼만 줄어야 하고, `gjc_intents`·`notification_intents`·`personal_context_audit_events`·`local_timeline_subjects`는 동일해야 한다. 실측: 사전 교체 시 재구축이 대체 파일에서 실패하고 fence가 `LOCAL_RETENTION_SOURCE_CHANGED`로 보고한다. 테스트는 코드가 아니라 계약(거절 + 후보 미잔존)을 단정하며, 복사 대조는 "교체본으로도 빌드가 성공해 버리는" 경우를 위한 방어다 |
| 매트릭스에 취소/재시작이 없다 | 거절 후 같은 목적지로 재시도가 성공함을 단정한다. 거절이 claim도 후보도 남기지 않았고, 재시도는 바뀐 원본을 다시 선정해 알림이 가리키는 그룹을 보존한다 |
| "정리된 snapshot"은 `snapshot_missing`이지 진짜 원본 부재가 아니다 | 대상 task 행을 지워 `TaskTimeline`이 `TASK_TIMELINE_NOT_FOUND`를 던지는 `source_missing` 분기를 자식 프로세스로 검증한다 |
| capped 미커버 | **이후 닫았다.** 대상 intent의 `gjc_intent_events`를 64건×4KiB로 키워 128KiB 예산을 넘기면 `TaskTimeline`이 이벤트를 잘라 수집 상태가 `capped`가 된다. 실측: `refresh()` 스냅샷 `capped`, `read()` → `unavailable`/`capped`, `admitLocalTimelineObservation` → `LOCAL_OBSERVATION_SOURCE_UNAVAILABLE`, 자식 프로세스는 exit 0에 brief `item_count=0`. 음성 증거 기록 경로(행마다 고유 `control_command_requests`)는 범위 밖으로 남긴다 |

1·2차 판정은 REJECT였고 남은 근거는 capped 프로세스 인수 한 건이었다. 승인으로 바꾸려 재검토를 돌리는 대신 그 한 건을 실제로 구현했고(`2673e4a`), 그 뒤 독립 리뷰어에게 그 커밋만 좁게 3차 감사를 받아 **APPROVE**를 받았다. 리뷰어가 직접 확인한 것: fixture가 상태를 위조하지 않고 실제 제품 경로(`gjc_intent_events` → `TaskTimeline.context` 절단 → `LocalTimelineCollection` capped)를 지난다는 것, 단정 사슬이 주장만큼 강하다는 것, 세 기록이 커버 범위와 미커버(negative_evidence 기록 경로)를 정확히 적었다는 것, 기존 케이스를 약화시키지 않고 파일에 sleep·벽시계 의존이 없다는 것, 그리고 8/8 통과. 보고서는 `/home/jm/.cache/jarvis-lineage-qa/gate-review.md`에 3차까지 누적돼 있다.

## 리뷰 재현 스크립트 재실행

리뷰의 `reproduce.mjs`를 그대로 복사해 출력 디렉터리 한 줄만 바꿔(`/home/jm/.cache/jarvis-lineage-qa/repro-after-fix`) 원본 증거를 덮어쓰지 않고 실행했다.

| 케이스 | 수정 전 | 수정 후 |
|---|---|---|
| `same_source_dot_path` | `source_exists_after=false`, `MEMORY_COMPACTION_ROW_INVALID` | `source_exists_after=true`, before/after digest 동일, `LOCAL_RETENTION_DESTINATION_INVALID` |
| `existing_destination` | `destination_overwritten=true`, error 없음 | `destination_overwritten=false`, `LOCAL_RETENTION_DESTINATION_INVALID` |
| `source_checkpoint_changes_bytes` | WAL 20,632→0, db bytes 변경, `total_changes` 105→105 | 동일(동작 유지). 이제 계약에 명시되고 테스트로 고정됨 |
| `notification_inserted_after_selection` | 성공, `recommendations_after=0`/`notification_intents_after=1` | `LOCAL_RETENTION_SOURCE_CHANGED`로 거절 |

## 명령과 결과

| 명령 | 결과 |
|---|---|
| `npm run verify` (통합 후 1회, 최종) | **exit 0**. backend 275파일/1,885 + 275파일/1,911, dashboard 38파일/263 → 합계 **588파일 / 4,059테스트**. 고정 시각 acceptance `pre_gjc_ready`/`stopped`/`completion_promoted=true`/`gjc_dispatched=false` |
| `npm run typecheck` / `npm run lint` / `npm run architecture:check` | RC 0 / RC 0 / 657모듈·2,441간선·순환 0 |
| `npm run test:integration -- <builder 도달 테스트 16파일>` | 16파일 / 79테스트 통과, 185초 (R1 시점) |
| `npm run test:integration -- <retention 4파일>` | retention 12/12, destination 3/3, consistency 8/8, source-writes 1/1 |
| `npm run test:integration -- tests/integration/daily-morning-cli-process.test.ts` | 1파일 / **8테스트** 통과 (capped 추가 후 최종) |
| `node <리뷰 reproduce.mjs 사본>` (최종 빌드) | `source_exists_after=true`·digest 동일, `destination_overwritten=false`, interleaving `LOCAL_RETENTION_SOURCE_CHANGED`, checkpoint 케이스는 동작 유지 |

전체 verify는 통합 시점에 1회만 끝까지 돌렸다. 그 이전 두 번의 실행은 각각 리뷰가능성 실패(모듈 줄 수 초과)와 그 수정 도중 트리가 바뀌어 무효였으므로 중단했고, 무효 실행의 결과를 이 표에 쓰지 않았다.

## 남은 한계와 재개 조건

- retention 일정화와 교체 프로토콜(원본/candidate identity, writer 배제, 중단 복구)은 미구현이다. `verifyLocalObservationRetentionCandidate`는 교체 직전 검사만 제공한다.
- 끊긴 notification의 제거/suppress/유지 정책은 여전히 사용자 결정이며, 이번 수정은 ‘참조되는 그룹 유지’ 계약을 지키는 쪽이다.
- 실제 producer(assembler → 추천) 경로 연결은 위 R4 항목대로 미완료다.
- provider refresh receipt 계약, 실행자 설정(`JARVIS_TASK_CLAUDE_PATH`, verifier key path/id), 그리고 capped 결과를 `negative_evidence`로 **기록**하는 경로(행마다 고유 `control_command_requests` FK)는 범위 밖이다. capped 수집 자체의 인수는 닫았다.
- push·merge·deploy·서비스 재시작·운영 DB 변경·운영 교체는 하지 않았다. `node_modules`는 손대지 않았고 다른 작업의 산출물도 지우지 않았다.

## 증거 경로

- `/home/jm/.cache/jarvis-lineage-qa/repro-after-fix/reproduce-result.json` — 재현 재실행 결과
- `/home/jm/.cache/jarvis-lineage-qa/verify-final.log` — 통합 후 전체 verify 로그(exit 0)
- `/home/jm/.cache/jarvis-lineage-qa/gate-review.md` — 독립 게이트 리뷰 및 2차 재감사 보고서
- `/home/jm/.cache/jarvis-lineage-qa/verify-receipts.json` — 실행별 monitor/RC 출처 구분
- 리뷰 원본 증거 `/home/jm/.cache/jarvis-opus-review-20260910/`는 변경하지 않았다.
