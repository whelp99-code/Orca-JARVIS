# 최종 회신서 — R1–R4 수정 완료, 2026-09-11

`docs/opus-verification-reply-2026-09-10.md`의 R1–R4와 `docs/opus-work-instructions-2026-09-10.md`의 지시에 대한 최종 회신이다. 진행 중 기록은 `docs/opus-fix-reply-2026-09-10.md`에 있고, 이 문서는 종료 상태만 정리한다. 모든 수치는 실행 결과이며, 추정치는 넣지 않았다.

## 판정

**R1·R2(P1) 두 결함은 수정됐고, 리뷰의 재현 스크립트는 더 이상 재현하지 못한다. R3는 계약 정정과 측정으로, R4는 실제 프로세스 인수 매트릭스 완결로 닫았다.** production 적용·교체·배포는 한 건도 하지 않았다.

이 문서는 두 번 갱신됐다. `31514bd` 최초 작성 이후 재검증(`docs/opus-final-review-2026-09-11.md`, 커밋 `5357f44`)이 **R2에 남은 결함**을 재현했고 — 열린 WAL 원본의 경로를 행 수가 같고 내용이 다른 DELETE 모드 DB로 교체하면 잘못된 후보가 만들어지고 재검증까지 통과했다 — 그 결함은 `c7cc50b`으로 수정했다. 아래 R2 절과 “R2 재개” 절이 최신 상태다.

독립 게이트 리뷰는 3회 받았고 마지막 판정은 APPROVE지만, **그 3차의 대상은 `2673e4a`의 capped 테스트 한 건으로 제한**돼 있다. R2 전체나 `52db87d`에 대한 독립 승인이 아니며, `c7cc50b`은 아직 독립 재검토를 받지 않았다.

## 대상과 커밋

- worktree `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, branch `codex/routing-approval-ui`
- 시작 `5c99b27`. 이 문서 작성 시점의 커밋은 9건(`21ccb26`)이었고, 이후 재검증 대응으로 `c7cc50b`(원본 파일 동일성)과 행 출처 검증 커밋이 더해졌다. 아래 “R2 재개” 절이 최신이며, 그 커밋들은 `src`를 바꾸므로 전체 verify를 다시 수행한다. migrations 변경 **0**, `node_modules` 추적 **0**.
- 기존 커밋 `5cd42a5`/`ba1d37e`/`9a9abdf`는 손대지 않았다.

| # | SHA | 구간 | 내용 |
|---|---|---|---|
| 1 | `7297671` | R1 | 적용 목적지 배타 소유권(realpath 동일성·sidecar 검사·`O_EXCL`), builder의 `claimed` 모드 |
| 2 | `0197ce0` | R2 | 선정–복사 fence, FK 없는 `deep_link` 참조 검사, stale 후보 검증 |
| 3 | `3529ca6` | R3 | 원본 쓰기 계약 정정 + 신호 분리 측정 |
| 4 | `a9358d5` | R4 | 실제 자식 프로세스 인수 도입 |
| 5 | `72e85c0` | 리뷰 1차 | fence에 device/inode, 인터리빙 2건, SHM 측정, 문서 모순 정정, 모듈 분할 |
| 6 | `52db87d` | 리뷰 2차 | 후보를 선정이 읽은 연결과 대조, 재시작 회귀, 진짜 `source_missing` |
| 7 | `3158a29` | 보고 | 진행 회신서 |
| 8 | `2673e4a` | R4 잔여 | capped 수집 인수로 프로세스 매트릭스 완결 |
| 9 | `21ccb26` | 보고 | 3차 판정(APPROVE) 기록, 오표기 정정 |
| 10 | `c7cc50b` | R2 재개 | 열린 연결이 읽는 파일로 fence 결속(`/proc/self/fd`) |
| 11 | 아래 참조 | R2 재개 | 복사된 행의 출처 검증으로 대체(행 수 비교 제거) |

## R1 — 적용 목적지 소유권

원인은 두 겹이었다. 적용이 `freshPath === source.filename` 문자열만 비교했고, `buildFreshAuthority`가 목적지를 `rmSync(force)`로 지웠다. 문자열이 다르면 같은 파일이어도 통과했다.

수정: 목적지의 real path를 해석해 원본 파일 자체를 거절하고, SQLite sidecar가 이미 있는 이름을 거절하며, `O_EXCL`로 파일을 만들어 소유권을 선점한다. builder에는 명시적 목적지 모드를 넣었다 — `replace`는 compaction·restore 호출자의 기존 계약 그대로, `claimed`는 builder가 자기가 만들지 않은 경로를 절대 지우지 않는다. 실패 시 정리는 이 호출이 확보한 파일과 그 sidecar만 대상으로 한다.

인수(`local-observation-retention-destination.test.ts` 3테스트): 원본 자신·`/./`·정규화된 상대·cwd 기준 상대·symlink 별칭, 기존 텍스트 파일·기존 DB·main 없이 `-wal`만 남은 이름 전부 `LOCAL_RETENTION_DESTINATION_INVALID`. 이후 원본 sha256과 sidecar 해시 동일, symlink 보존, 새 연결로 재오픈해 행 수 확인. 동시 두 호출은 정확히 1건만 성공. 공유 builder에 도달하는 테스트 전체 회귀 16파일/79테스트(185초).

## R2 — 선정과 복사의 일관성

원인: `buildFreshAuthority`가 `await fresh.migrate()`에서 양보하므로 선정 이후의 쓰기가 복사에 포함된다. 리뷰 재현은 그 틈에 notification을 넣어 `recommendations=0`/`notification_intents=1`인 후보가 `foreign_key_errors=0`으로 성공 반환되는 것을 보였다.

수정 4겹:
1. fence를 선정 **전에** 읽고 빌드 후 다시 읽는다. 이 연결의 `total_changes`, 다른 연결의 `data_version`, 그리고 경로의 device/inode까지 고정한다. 움직였으면 `LOCAL_RETENTION_SOURCE_CHANGED`.
2. 후보를 **선정이 읽은 연결**과 대조한다. 선정이 바꿀 수 있는 표는 차단한 만큼만 줄어야 하고, `gjc_intents`·`notification_intents`·`personal_context_audit_events`·`local_timeline_subjects`는 동일해야 한다. 경로가 호출 전에 이미 교체돼 fence가 자기 자신과 일관된 경우를 위한 방어다.
3. FK도 인덱스도 없는 `notification_intents.deep_link` 참조를 제거된 추천에 대해 검사해 `LOCAL_RETENTION_REFERENCE_DANGLING`.
4. fence가 결과에 실려 나가 `verifyLocalObservationRetentionCandidate`가 교체 직전 재확인한다. 거절된 후보는 sidecar와 함께 삭제한다.

인수(`local-observation-retention-consistency.test.ts` **11테스트**, sleep 없음, adapter 자신의 yield 또는 호출 전 동기 rename으로 구동): 같은 연결·두 번째 연결의 notification 삽입, 복사 중 경로 교체, 두 번째 연결이 context 체인 전체 추가, 선정이 읽지 않은 파일에서 복사된 후보, 거절 후 재시도 성공, dangling 참조 탐지, 생성 후 원본 이동 시 stale 판정, 그리고 아래 R2 재개에서 추가한 동일 행 수 교체 2건(WAL→DELETE, DELETE→WAL)과 빌드 후 경로 교체 1건.

### R2 재개 — 행 수는 내용의 증거가 아니다 (`c7cc50b`)

재검증이 재현한 결함: 열린 연결이 WAL 원본을 읽는 동안 그 pathname을 **행 수가 같고 내용이 다른 DELETE 모드 DB**로 바꾸면, pathname을 stat한 device/inode도, 후보와 원본의 행 수 비교도 모두 자기 자신과 일관되어 통과한다. 그래서 선정이 읽지 않은 파일에서 복사된 후보가 성공 반환되고 재검증까지 통과했다. journal mode 조합이 조건의 일부다 — DELETE 교체본은 WAL 기반 신호를 전혀 건드리지 않기 때문에, 앞서 WAL→WAL 교체를 막았던 것은 설계가 아니라 부작용이었다.

수정: fence가 **열린 연결이 실제로 읽는 파일**의 device/inode를 이 프로세스의 디스크립터 표(`/proc/self/fd`)에서 읽어, pathname이 가리키는 파일과 대조한다. 불일치는 `LOCAL_RETENTION_SOURCE_IDENTITY_MISMATCH`, 디스크립터 표를 읽을 수 없으면 `LOCAL_RETENTION_SOURCE_IDENTITY_UNVERIFIED`로 **거절**한다(증명 불가 시 가정하지 않는다). 행 수 비교는 남기되 두 기록과 코드 주석에서 “내용의 증거가 아니라 보조 점검”으로 명시했다.

실측(직접 확인): 교체 후 열린 fd는 원래 inode를 유지하고 pathname은 다른 inode로 해석된다 — pathname에서 유도한 어떤 신호로도 표현할 수 없는 차이다. 리뷰의 재현 스크립트를 출력 경로만 바꿔 수정 빌드에서 실행한 결과, `WAL/DELETE`와 `DELETE/WAL` 두 모드 모두 `error=LOCAL_RETENTION_SOURCE_IDENTITY_MISMATCH`, `candidate_exists=false`, 원본은 `{"marker":"selected-source"}` 유지였다(`/home/jm/.cache/jarvis-lineage-qa/repro-identity/mixed-journal-source-result.json`).

회귀: 동일 행 수 교체를 호출 **전에** 수행한 두 journal 조합, 빌드 **후** 교체 시 stale 판정. 기존 R1·notification interleaving 회귀는 그대로 유지된다.

#### 독립 R2 전체 감사가 다시 지적한 것과 그 처리

`c7cc50b` 직후 R2 전체(0197ce0·72e85c0·52db87d·c7cc50b)를 독립 감사에 넘겨 **REJECT**를 받았다. 핵심 지적은 정확했다: fence의 두 검사는 빌드의 **앞뒤**만 감쌀 뿐, adapter가 중간에 수행하는 `ATTACH`를 묶지 못한다. 경로를 ATTACH 직전에 바꾸고 직후 되돌리면 양 끝점·연결 카운터·행 수가 모두 자기 자신과 일관돼 잘못된 복사가 통과할 수 있다.

처리: 행 수 비교를 이 경로에서 **제거**하고, **복사된 행의 출처**를 검증한다(`src/local-observation-retention-candidate.ts`). 후보의 모든 행은 선정이 사용한 연결에도 존재해야 하며, 복사가 일부러 비우는 열(`local_timeline_subjects`의 snapshot/collection/expiry)은 원본 쪽도 비워 비교하고, 빌드가 다시 쓰는 두 표(`schema_migrations`, `memory_database_generations`)는 제외한다. 없는 행은 `LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW`다. retention 선정은 행을 지우기만 하므로 “부분집합은 정상, 외래 행은 비정상”이 성립하고, adapter의 표별 필터를 재구현하지 않고도 판정할 수 있다. 어떤 파일이 ATTACH됐는지를 묻는 대신 **무엇이 복사됐는지**를 확인하므로, ABA 타이밍이든 다른 경로든 결과가 걸린다.

같은 감사가 짚은 나머지도 처리했다: 복사 중 recommendation replacement 쓰기 인수를 추가했고(두 번째 연결에서 `replacement_recommendation_id` 기록 → `LOCAL_RETENTION_SOURCE_CHANGED`), 행 수를 “증거”라고 부르던 함수 JSDoc과 이름은 함수 자체를 대체하며 사라졌다. 남은 한계는 정직하게 적는다 — ABA 창을 **경합으로 재현하는** 회귀는 단일 프로세스 이벤트 루프에서 결정적으로 만들 수 없어, 그 효과(외래 행)를 직접 단정하는 테스트로 대신했다. 그리고 프로세스가 갑자기 죽으면 배타 확보된 목적지에 부분 파일이 남고, 이후 재시도는 그 목적지를 거절한다(덮어쓰지 않는다).

실측: consistency **13테스트**, retention 세트와 공유 builder 호출자까지 **11파일/62테스트 통과**. typecheck RC 0, lint RC 0, architecture 658모듈·2,444간선·순환 0.

## R3 — 원본 쓰기 계약

`buildFreshAuthority`는 원본에 `wal_checkpoint(TRUNCATE)`를 실행한다. 동작은 바꾸지 않고 계약을 사실대로 고쳐 코드 주석과 두 기록에 넣었고, 지표를 분리해 측정으로 고정했다.

측정(`local-observation-retention-source-writes.test.ts` 1테스트): 적용 후 `total_changes()` 동일, 대상 7개 표의 논리 행 수 동일, main 파일 sha256 **변경**, WAL **0으로 절단**, SHM 크기 동일·존재, 새 연결 재오픈 시 내용 동일. 정확한 계약은 “교체 없음, 삭제 없음, 논리 변화 없음, 원본 WAL에 대한 유지보수 쓰기 있음”이다.

## R4 — 실제 프로세스와 producer 경계

`daily-morning-cli-process.test.ts` 8테스트가 자식 프로세스로 검증하며, 모든 확인은 프로세스 종료 후 새 연결로 읽는다.

- 실제 제품 바이너리 `node dist/src/cli.js daily morning --once`: 사용 불가 설정에서 exit **2**, stderr `DAILY_LOOP_CONFIG_INVALID`, stdout 비어 있음, DB sha256 불변, `daily_loop_runs` 0.
- 제품 바이너리에 clock 우회는 만들지 않았다. 고정 시각 케이스는 같은 dist 빌드를 실행하는 테스트 전용 진입점(`tests/fixtures/compiled-daily-cli.ts` → `dist/tests/fixtures/compiled-daily-cli.js`)으로 돌린다. 임의 시각에 실제 바이너리를 그대로 돌리면 `DAILY_LOOP_MISSED_RECOVERY_WINDOW` exit 2다(실측). 아침 창이 07:15:00.000 KST 한 점이기 때문이다.
- 매트릭스: 정상 발행(`provider_refresh=unavailable`, `automatic_operation=hold`, brief `ready`/`item_count=1`), 재실행 무중복, hold 기권, 만료, 캐시 정리(`snapshot_missing`), 타임라인 부재(`source_missing`), 대체 소스, capped.
- capped는 제품 경로로 도달한다: 대상 intent의 `gjc_intent_events` 64건×약 4KiB로 128KiB 예산을 넘기면 `TaskTimeline.context`가 이벤트를 잘라 `truncated`가 되고 수집 상태가 `capped`가 된다. 그 뒤 `read()`는 `unavailable`/`capped`, `admitLocalTimelineObservation`은 `LOCAL_OBSERVATION_SOURCE_UNAVAILABLE`로 거절한다(잘린 수집을 인용하는 관측은 생길 수 없다). 자식 프로세스는 exit 0에 brief `item_count=0`.

**닫지 않은 것**: 이 체인은 여전히 `tests/fixtures/local-observation-chain.ts`가 `linux_live_fact`/`user_confirmed_principle`/`owner_decision`을 직접 구성한 증거다. 실제 assembler는 `context_observation`/`confirmed_memory`를 낸다. 따라서 fixture 체인이 brief에 도달한 것은 실제 producer 경로가 도달한 것이 아니며, 두 기록에 그대로 적었다.

## 두 P1 재현 결과

리뷰의 `reproduce.mjs`를 그대로 복사해 출력 디렉터리 한 줄만 바꿔(원본 증거 미변경) 최종 빌드에서 실행했다.

| 케이스 | 수정 전 | 수정 후 |
|---|---|---|
| `same_source_dot_path` | `source_exists_after=false`, `MEMORY_COMPACTION_ROW_INVALID` | `source_exists_after=true`, before/after digest 동일, `LOCAL_RETENTION_DESTINATION_INVALID` |
| `existing_destination` | `destination_overwritten=true`, error 없음 | `destination_overwritten=false`, `LOCAL_RETENTION_DESTINATION_INVALID` |
| `source_checkpoint_changes_bytes` | WAL 20,632→0, db bytes 변경, `total_changes` 105→105 | 동일(동작 유지). 이제 계약에 명시되고 테스트로 고정됨 |
| `notification_inserted_after_selection` | 성공, `recommendations_after=0`/`notification_intents_after=1` | `LOCAL_RETENTION_SOURCE_CHANGED`로 거절 |

## 게이트와 그 적용 범위

| 명령 | 결과 | 덮는 범위 |
|---|---|---|
| `npm run verify` (R2 재개 후, 최종) | **exit 0**. backend 275파일/1,886 + 275파일/1,916, dashboard 38파일/263 → **588파일 / 4,065테스트**. architecture 658모듈·2,444간선·순환 0. 고정 시각 acceptance `pre_gjc_ready`/`stopped`/`completion_promoted=true`/`gjc_dispatched=false` | HEAD `c0c0382`, tree `3397ecb`, 입력 digest `sha256:4a7f7b91…`(1,595파일), 종료 2026-09-11 09:05:20 +09:00 |
| `npm run verify` (이전) | exit 0. backend 275파일/1,885 + 275파일/1,911, dashboard 38파일/263 → 588파일 / 4,059테스트 | `52db87d` 시점 제품 코드 |
| `npm run typecheck` / `npm run lint` / `npm run architecture:check` | RC 0 / RC 0 / 657모듈·2,441간선·순환 0 | 현재 HEAD |
| `npm run test:integration -- <retention 4파일>` | retention 12/12, destination 3/3, consistency 8/8, source-writes 1/1 | 현재 HEAD |
| `npm run test:integration -- daily-morning-cli-process.test.ts` | 1파일 / **8테스트** 통과 | 현재 HEAD |
| `node <리뷰 reproduce.mjs 사본>` | 위 표대로 두 P1 재현 소멸 | 최종 빌드 |

이 표의 전체 verify는 `52db87d` 시점 제품 코드를 덮는다. 그 직후 세 커밋(`3158a29`, `2673e4a`, `21ccb26`)은 `src`를 바꾸지 않았으므로 그때는 게이트를 반복하지 않았다. **그 판단은 `c7cc50b` 이후로는 더 이상 성립하지 않는다** — 재검증 대응이 `src/local-observation-retention.ts`를 바꾸고 새 모듈을 추가했으므로 전체 verify를 다시 수행하며, 그 결과는 아래 “R2 재개”에 기록한다.

중간에 시작한 전체 verify 두 번은 결과로 쓰지 않았다. 1회차는 리뷰가능성 한도 초과로 실패했고(그 실패가 실제 회귀를 잡아냈다), 2회차는 그 수정 도중 트리가 바뀌어 무효였으므로 중단했다.

## 독립 게이트 리뷰 3회

| 회차 | 판정 | 지적과 처리 |
|---|---|---|
| 1차 (네 커밋 대상) | REJECT | fence가 열린 연결 카운터만 봄 → device/inode 추가. 인터리빙 매트릭스 부족 → 경로 교체·두 번째 연결 체인 추가. WAL/SHM 표기와 측정 불일치 → SHM 측정 추가. 계획 문서의 “미구현” 모순 → 정정. 또한 리뷰와 무관하게 전체 게이트가 잡은 실제 회귀(모듈이 리뷰가능성 한도 250줄 초과)를 모듈 분리로 해소 |
| 2차 (`72e85c0` 대상) | REJECT | 호출 전에 경로가 이미 교체된 경우 → 후보를 선정이 읽은 연결과 대조. 취소/재시작 부재 → 거절 후 재시도 회귀. `snapshot_missing`을 원본 부재로 오인 → 진짜 `source_missing` 케이스. capped 미커버는 이 시점에 남김 |
| 3차 (`2673e4a`의 capped 케이스**만**) | **APPROVE** | capped가 fixture 위조가 아니라 제품 경로를 지난다는 것, 단정 사슬이 주장만큼 강하다는 것, 기록이 커버·미커버를 정확히 적었다는 것, 기존 케이스 약화 없음과 sleep·벽시계 의존 없음, 8/8 통과를 직접 확인. **범위가 capped 한 건이므로 R2 전체나 `52db87d`의 독립 승인으로 쓰지 않는다** |
| 사용자 재검증 (`5357f44`) | 인수 보류 | 행 수 일치가 내용 일치를 보장하지 않음을 재현. `c7cc50b`으로 수정했고, 이 커밋은 아직 독립 재검토를 받지 않았다 |

보고서 전문은 `/home/jm/.cache/jarvis-lineage-qa/gate-review.md`에 3차까지 누적돼 있다.

## 남은 것과 재개 조건

| 항목 | 재개 조건 |
|---|---|
| capped 결과의 `negative_evidence` 기록 | `migrations/028` 가드가 행마다 고유한 level-2 `evidence.negative.record` 요청·승인 receipt·redemption을 요구한다. 수집 상태 capped 자체의 인수는 닫혔다 |
| retention 일정화와 교체 프로토콜 | 언제 돌릴지, 그리고 원본/candidate identity·writer 배제·중단 복구·stale 거절을 갖춘 교체. `verifyLocalObservationRetentionCandidate`는 교체 직전 검사만 제공한다 |
| opt-in 반복 접수 연결 | 위 두 가지 이후. 지금 켜면 회수 실행 주체 없이 저장이 증가한다 |
| 끊긴 notification 정책 | 제거/suppress/유지는 사용자 결정. 현재 구현은 “참조되는 그룹 유지” |
| 실제 producer 경로 | assembler의 `context_observation`/`confirmed_memory`를 추천이 요구하는 증거로 잇는 계약. evidence kind 문자열 치환이나 `sufficient` 강제로 잇지 않는다 |
| §5.C provider refresh receipt | cap 결과·provider release 식별자·refresh↔scoped request 매핑을 상대 과제와 합의 |
| §5.D 실제 업무 1건 | 운영자가 `JARVIS_TASK_CLAUDE_PATH`, verifier key path/id를 대상 환경에 설정 |

## 하지 않은 것

push, merge, deploy, 서비스 재시작, 운영 DB 변경, 운영 교체는 없다. shipped migration은 0파일 변경했고 새 migration도 추가하지 않았다. `node_modules`는 추적·삭제하지 않았다. scratch는 러너 기본값(`~/.cache/orca-jarvis/tests`)과 `~/.cache/jarvis-lineage-qa`만 썼고 `/tmp`는 쓰지 않았으며(초기 `EDQUOT`는 내 scratch를 옮겨 우회했다), 다른 작업의 산출물은 지우지 않았다. 동시성은 전부 결정적 제어로 재현했고 테스트에 sleep은 없다.

## 증거 경로

- `/home/jm/.cache/jarvis-lineage-qa/verify-provenance.log` — R2 재개 후 전체 verify(exit 0, HEAD `c0c0382`)
- `/home/jm/.cache/jarvis-lineage-qa/repro-identity/mixed-journal-source-result.json` — 재검증 재현을 수정 빌드에서 재실행한 결과
- `/home/jm/.cache/jarvis-lineage-qa/verify-final.log` — 이전 전체 verify(exit 0, `52db87d` 범위)
- `/home/jm/.cache/jarvis-lineage-qa/verify-receipts.json` — 실행별 monitor/RC/종료 시각/입력 digest. 중단한 실행은 killed와 사유로 남겼다. 마지막 run의 빌드 metadata `source.dirty=true`는 추적되지 않는 도구 상태(`.omo/**`)와 `node_modules` 때문이며, tracked 변경은 0이다
- `/home/jm/.cache/jarvis-lineage-qa/repro-after-fix/reproduce-result.json` — 재현 재실행 결과
- `/home/jm/.cache/jarvis-lineage-qa/gate-review.md` — 독립 리뷰 3회 보고서
- `/home/jm/.cache/jarvis-lineage-qa/retention-config-live.log` — 컴파일 CLI `retention-preview` 실측
- 리뷰 원본 증거 `/home/jm/.cache/jarvis-opus-review-20260910/`는 변경하지 않았다.

이 결과로 01–25 전체 완료나 자비스·세컨드브레인 운영 완료를 선언하지 않는다.
