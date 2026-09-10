# 인계 이어받기 결과 — JARVIS, 2026-09-10

`docs/cursor-handoff-2026-09-10.md`를 원본 지시서로 삼아 §5의 순서와 검증 기준을
따라 이어서 수행한 결과다. 원본 지시서는 수정하지 않았다. 아래는 모두 실측이며,
production 적용은 한 건도 하지 않았다.

## 1. 작업 checkout과 경계

- worktree `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`
- branch `codex/routing-approval-ui`, 시작 HEAD `1b67692`, Node v24.19.0
- 시작 시 상태 `?? node_modules` 1개, tracked 변경 0개. 공유 의존성 경로이므로
  추가·삭제·커밋하지 않았다.
- push, merge, deploy, 서비스 재시작, 운영 설정 변경, 운영 DB 변경은 하지 않았다.
- Second Brain checkout은 읽기 전용으로만 열었고 provider 파일을 쓰기로 열거나
  provider 프로세스를 실행하지 않았다.

## 2. 커밋과 근거

| SHA | 구간 | 내용 |
|---|---|---|
| `b4df634` | A | stale local source 추천을 현재 조회 경로에서 철회 |
| `353b29b` | A | 발행된 brief의 현재 증거 주장 철회 |
| `04d333c` | B | 증가량·중복 신호·보존/참조 계약 실측 |
| `360995b` | B | 재시작·중복 기동 수집 증가량 실측 |
| `d365740` | C | provider refresh receipt 의존성 최신 HEAD 재확인 |
| `9b55b37` | D | 실행자 설정 공백 읽기 전용 재확인 |
| `61b3503` | B | 대체된 local source를 brief 전체 실패 대신 제외 |
| `e2504ac` | B | 보존 cutoff 경계를 rebuild adapter로 실측 |
| `4f4e73f` | 보고 | 이 인계 이어받기 결과 문서 |
| `3a06e83` | B | 수집 cycle을 재시작·중복 기동에 대해 내구성 fence로 차단 |
| `fa89ea1` | B | cutoff가 끊게 될 notification 참조를 실측 |
| `d889966` | 보고 | 이어받기 기록을 최종 실측 상태로 갱신 |
| `97edb20` | B | 보존 cutoff 선정 표면(읽기 전용, 삭제 없음) |

전체 verify는 `b4df634`, `353b29b`, `61b3503`, `3a06e83` 시점에서 각각 exit 0으로
통과했다. 마지막 통과 실측(`3a06e83`, `verify4.log`): backend shard1 272파일/
1862테스트, shard2 272파일/1899테스트, dashboard 38파일/263테스트, 합계
582파일/4024테스트. architecture 655모듈/2434간선/순환 0. 고정 시각 acceptance
`pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`,
`gjc_dispatched=false`. 증거 로그는 `/home/jm/.cache/jarvis-lineage-qa/`의
`verify.log`, `verify2.log`, `verify3.log`, `verify4.log`. git에 포함되지 않는
로컬 증거이며, 다른 머신에서 접근할 수 없으면 재현해야 한다.

`e2504ac`와 `fa89ea1`은 src 변경이 없어 대상 테스트·typecheck·lint로 검증했고
전체 verify를 반복하지 않았다. 원본 지시서 §8의 "실패 원인 없이 같은 전체 검증을
반복하지 않는다"를 따른 것이다.

실제 프로세스 검증: 컴파일된 `dist/src` 모듈만 로드하는 별도 node 프로세스로
격리 DB에 대해 lineage와 발행 경로를 재현했다(`lineage-live.json`,
`publication-live.json`, 각각 `failures: []`). 컴파일된 `jarvis daily morning --once`
CLI는 이 체인에 사용하지 못했다(아래 HOLD 참조).

## 3. §5.A 결과

로컬 관측이 context와 recommendation을 거쳐 morning brief까지 이어지는 체인을
하나의 격리 DB에서 재현하고, ID·digest·유효기간 결속을 고정했다. 그 위에서
두 개의 실제 결함을 측정해 고쳤다.

1. `projectRecommendations`가 hold·교체·quarantine 이후에도 추천을 현재 실행
   가능한 것으로 계속 노출했다. 이제 인용된 local 관측을 기존 deferred read
   transaction 안에서 재검증하고, 해당 action을 `next_actions`와
   `owner_decisions_needed`에서 제외하며 `RECOMMENDATION_SOURCE_UNAVAILABLE`
   경고를 낸다. 저장 이력은 `lifecycle_actions`에 그대로 남는다.
2. 발행된 brief가 원본이 사라진 뒤에도 `state=ready`, `item_count=1`로 보고했다.
   이제 `stale`/`item_count=0`이 되고 `brief_id`와 `generated_at`은 보존된다.

정책 구분을 명문화했다. 저장된 과거 산출물은 계속 읽히되, 현재 실행 가능한
표면은 읽는 시점에 원본이 일치해야 한다. 저장물 replay는 저장 metadata 반환이며
현재 증거 검사가 아니다.

## 4. §5.B 결과

조사·계약 항목은 모두 실측으로 마쳤다.

- 증가량: 변하지 않는 8대상 10주기에서 관측 80행, audit 80행, cache는 8행 유지.
  관측당 약 5.7KiB. cache 상한은 저장을 제한하지 않는다.
- 중복 신호: 80행의 `canonical_digest`와 `content_digest`는 모두 서로 다르지만
  `collection_content_digest`는 8개, task state는 1개다. 두 digest는 collection ID를
  포함하므로 저장 식별자이지 업무 중복 판정이 아니다. collection별 새 ID 요구는
  유지했고, 중복은 원본 바이트와 task 상태로 판정해야 한다.
- 보존: 이 계보의 모든 표에 immutable delete trigger가 있어 단순 DELETE는 중단된다.
  유일한 승인 경로는 `buildFreshAuthority` 재구축이다.
- 참조 계약: 인용된 관측만 차단하면 `MEMORY_COMPACTION_FOREIGN_KEY_INVALID`로
  거절되고 원본 DB는 그대로다. 인용 context와 그 recommendation을 함께 차단하면
  `foreign_key_errors=0`, `integrity_check=ok`, generation+1로 성공한다.
- 삭제 계보: `personal_context_audit_events`는 context 필터에서 제외되어 대상이
  제거돼도 audit 행 수가 보존된다. local cache 열은 재구축을 넘지 않는다.
- cutoff 경계: `expires_at<=?`는 경계값을 포함해 제거한다. 재구축본은 행이 줄지만
  파일은 커질 수 있다(실측 4,354,048 대 4,304,896). 보존은 행 계약이지 용량 약속이
  아니다.
- 재시작·같은 시각·중복 기동: 수집 cycle 자체는 아무것도 접수하지 않는다.

측정 중 드러난 결함 하나는 문서에 "완화된 제약"으로만 적혀 있던 것이었다.
반복 생산자에서 두 번째 주기부터 morning brief가
`MORNING_RECOMMENDATION_SOURCE_INVALID`로 영구 실패했다. 즉 중복 산출이 아니라
보고 자체가 사라졌고, 이는 자동 접수의 차단 사유다. 이제 대체된 local source는
suppressed/quarantined와 같은 방식으로 해당 후보만 제외하고
`excluded.source_unavailable`로 계수한다. 주기 n에서 저장 n, 원본 digest 1개,
`next_actions`는 최신 1건, 경고 n-1건, brief item 1건, contributor 1개다. 즉
중복 actionable 추천과 brief item은 0이다.

이 변경으로 발행 동작도 바뀌었고, 기존 단정 3개를 새 계약으로 다시 썼다. hold와
원본 부재 모두 run은 `completed`, brief는 `degraded`/`item_count=0`/
`no_authoritative_data`이며 철회된 내용은 저장 detail에 없다. 이전의 거절 동작은
morning step을 pending으로 남겨, 반복 생산자에서는 마지막 생산자가 대체될 때마다
같은 장애를 재현했을 것이다. 무결성 실패는 여전히 fail-closed다.

## 5. §5.C 결과

원본 지시서가 요구한 "최신 코드로 재확인"을 수행했다. 기록된 재검사는 Second Brain
`235a2e4` 기준이었으나 실제 workspace는 `codex/shared-memory-completion-20260907`의
`d1d06e2`로 26커밋 앞서 있었고, 읽는 동안 `832bc6b`로 더 진행됐다. 따라서 결과는
`d1d06e2` 시점 판독으로 명시했다.

의존성은 기록보다 좁아졌다. `scoped-request-status-v1` 프로파일의
`sb_request_status`가 proved 요청에 대해 `request_id`, `request_digest`,
`scope_digest`, `provider_instance_id`와 `content_digest`·`generation_id`·`head`·
`tree`를 담은 proof, 그리고 `proof_digest`·`status_digest`·`PROVIDER_PROVED`를 담은
receipt를 준다. `sb_generation_status`는 같은 fence 아래 활성 generation manifest를
보고한다.

남은 공백 3가지가 여전히 의존성이다. cap/완전성 결과 없음, provider release 식별자
없음, 그리고 두 표면 모두 문서화된 계약상 현재 가용성을 증명하지 않는다
("never evidence of current artifact availability"). 따라서 refresh completion은
proof와 같은 fence의 활성 generation 대조로 JARVIS가 구성해야 한다. refresh가 이
scoped write request에 대응되는지는 상대 과제의 질문이며 가정하지 않았다.

JARVIS 쪽 구분(미설정·실패·비호환·capped·stale·완료)은 이미 구현되어 있고
`tests/unit/daily-control-loop-time.test.ts`가 7가지 경우를 고정한다. 이쪽에 남은
것은 receipt 검증 adapter뿐이며 위 두 필드와 매핑 합의 전에는 작성할 수 없다.

## 6. §5.D 결과

컴파일된 `dist`의 `inspectTaskExecutors`와 `probeTaskExecutorRuntime`을 현재 개발
셸 환경에 대해 읽기 전용으로 실행했다. 이 표면은 설정 키 이름과 상태만 보고하며
값이나 비밀을 읽거나 출력하지 않는다.

결과는 이전 판독과 동일하다. 등록 1건 `claude-code`, `configuration=missing`,
`execution_available=false`, 누락 `JARVIS_TASK_CLAUDE_PATH`,
`JARVIS_TASK_VERIFIER_KEY_PATH`, `JARVIS_TASK_VERIFIER_KEY_ID`, runtime preflight
`not_probed`/`TASK_EXECUTOR_CONFIGURATION_MISSING`/`remote_verification=not_performed`.

이 판독은 개발 셸을 측정한 것이지 운영 서비스 환경이 아니며, 이전의 격리된 인증
실행 증거를 무효화하지도 갱신하지도 않는다. 세 설정이 모두 없으므로 구성된 실행
경로가 없고, 실제 허용 업무 한 건을 TaskSpec→승인→durable dispatch→실행 증거→
서명 검증→완료로 통과시키는 일은 이 checkout에서 시작할 수 없다.

## 7. 남은 HOLD와 재개 조건

| 항목 | 재개 조건 |
|---|---|
| B: cutoff 선정 표면 | `src/local-observation-retention.ts`로 구현했다. 읽기 전용 선정이며 삭제는 하지 않는다. 경계 포함 제거, 인용 관측의 context·recommendation 확장, notification이 가리키는 그룹 보류, 창 안의 관측을 함께 인용하는 context 보류를 포함한다. 끊긴 notification을 제거·suppress할지는 사용자 대면 결정이므로 고르지 않았고, 선정기는 "삭제하지 않음"만 택했다 |
| B: replacement FK 보류 규칙 | 해소됐다. fixture를 `localChainTimes` 기준 시각 매개변수화로 바꿔 두 주기를 서로 다른 base에 두었고, 교차 그룹 보류(`outside_event_names_replacement`)와 같은 그룹 비보류를 양쪽 다 측정했다. 매개변수화 과정에서 fixture 자체의 잠복 결함도 고쳤다: `extendLocalObservationChain`이 수집은 이전 store 시계로, 접수는 새 base로 하고 있어 뒤 주기가 이미 만료된 snapshot을 읽을 수 있었다 |
| B: cutoff 적용과 일정화 | 적용은 `applyLocalObservationRetention`으로 구현했다. 선정 결과를 재구축 adapter에 넣고 이 호출이 배타적으로 확보한 새 파일에 쓴다. 원본은 교체·삭제하지 않고 논리 행도 변하지 않으나, adapter가 원본에 `wal_checkpoint(TRUNCATE)`를 실행하므로 원본 main 파일 bytes는 바뀐다(초기 기록의 ‘원본 무기록’은 오류였다. `local-observation-retention-source-writes.test.ts`가 DML 수·논리 행·main sha256·WAL/SHM·재오픈을 각각 측정한다). 목적지는 realpath 동일성·sidecar 존재를 확인하고 `O_EXCL`로 만들며(`/./`·상대·symlink 별칭과 기존 파일, 경쟁 호출 모두 거절), 선정과 복사는 fence(`total_changes`+`data_version`)로 묶여 그 사이 원본이 바뀌면 `LOCAL_RETENTION_SOURCE_CHANGED`로 후보를 버린다. FK 없는 notification `deep_link` 참조는 별도 검사로 `LOCAL_RETENTION_REFERENCE_DANGLING`을 낸다. fence는 **열린 연결이 실제로 읽는 파일**의 device/inode를 `/proc/self/fd`에서 읽어 pathname이 가리키는 파일과 대조한다. 재구축 adapter가 `source.filename`을 자기 연결로 다시 열어 복사하므로, pathname을 stat하거나 행 수를 비교하는 것만으로는 결속이 안 된다(교체본이 같은 행 수·다른 내용이면 둘 다 통과한다). 불일치는 `LOCAL_RETENTION_SOURCE_IDENTITY_MISMATCH`, 디스크립터 표를 읽을 수 없으면 `LOCAL_RETENTION_SOURCE_IDENTITY_UNVERIFIED`로 거절한다. journal mode와 무관하며, 행 수 비교는 증거가 아니라 보조 점검으로만 남긴다. 알림이 붙잡아 둔 그룹은 재구축본에 그대로 남는다. cutoff 값 선택도 명시 설정으로 구현했다: `{schema_version:1, retain_ms}` 닫힌 레코드(300,000–31,536,000,000ms)를 파싱해 호출자 시계에서 되돌려 cutoff를 만들고, `timeline retention-preview CONFIG --db PATH`가 읽기 전용으로 창·cutoff·선정 결과만 보고한다. 컴파일된 CLI 실측: 3,600,000ms 창에서 cutoff `2026-09-10T12:02:20.127Z`, 하한 미만과 추가 키는 각각 exit 2 `LOCAL_RETENTION_CONFIG_INVALID`, DB sha256은 3회 모두 불변. 남은 것은 일정화(언제 돌릴지와 재구축본 교체)이며 운영자 결정이다 |
| B: opt-in 접수 연결 | 수집 cycle fence는 `3a06e83`, retention 선정·적용·설정 표면은 구현됐다(`97edb20`, `ba1d37e`, `7297671`, `0197ce0`). 남은 공백은 일정화와 교체 프로토콜이므로, 자동 접수를 켜면 회수 실행 주체가 없는 채로 저장이 계속 증가한다. 일정화와 교체가 격리 시험을 통과한 뒤에 연결한다. 자동 전체 task 등록은 하지 않는다 |
| B: 내용 기반 접수 dedup | 채택하지 않는다. 관측 식별자가 collection에 결속되므로 이전 관측을 재사용하면 cache 교체 즉시 영구 unavailable이 된다. 이는 "collection별 새 ID 요구를 제거해 중복을 숨기지 않는다"는 원본 지시와도 어긋난다 |
| C: provider receipt adapter | cap/완전성 결과와 provider release 식별자, refresh↔scoped request 매핑을 상대 과제와 합의 |
| D: 실제 업무 1건 인수 | 운영자가 대상 환경에 실행자 경로·검증 키 경로·키 ID를 설정 |
| 컴파일 daily CLI로 이 체인 구동 | 처리기와 실제 프로세스를 구분해 기록한다. `tests/integration/local-observation-daily-cli.test.ts`는 같은 프로세스에서 `execute()`를 호출하는 통합 테스트이고, `tests/integration/daily-morning-cli-process.test.ts`가 자식 프로세스 인수 검증이다: 실제 `node dist/src/cli.js daily morning --once`는 잘못된 설정에서 exit 2 `DAILY_LOOP_CONFIG_INVALID`를 내고 DB sha256이 불변이며, 고정 시각 케이스는 제품에 clock 플래그를 만들지 않기 위해 같은 dist 빌드를 쓰는 테스트 전용 진입점(`tests/fixtures/compiled-daily-cli.ts`를 빌드한 `dist/tests/fixtures/compiled-daily-cli.js`)으로 실행해 발행·재실행 무중복·hold 기권을 프로세스 종료 후 새 연결로 확인한다. 실제 바이너리를 임의 시각에 그대로 돌리면 `DAILY_LOOP_MISSED_RECOVERY_WINDOW` exit 2가 나온다(실측). 이 체인은 여전히 fixture가 만든 증거이므로 실제 producer 경로 완료가 아니다. 도달 과정에서 두 가지를 실측했다: 08-28 아침(`2026-08-27T22:15Z`)은 정책 `effective_at`(`2026-08-28T00:00:00.000Z`) 이전이라 `POLICY_NOT_EFFECTIVE`로 기권하므로 08-29 아침을 쓴다. 그리고 이 시점 CLI 실행은 `morning_reconcile` 행을 둘 이상 남기므로 단정은 completed 행을 골라야 한다 |
| `capped` 수집 상태 | 해소됐다. 대상 intent의 이벤트 로그를 128KiB 예산 너머로 키우면(`gjc_intent_events` 64건×4KiB) `TaskTimeline`이 이벤트를 잘라 `truncated`가 되고 수집 상태가 `capped`가 된다(`src/task-timeline.ts:183`, `src/local-timeline-collection.ts:35`). `tests/integration/daily-morning-cli-process.test.ts`가 실측한다: `refresh()`가 `capped` 스냅샷을 만들고, `read()`는 `unavailable`/`capped`를 반환하며, `admitLocalTimelineObservation`은 `LOCAL_OBSERVATION_SOURCE_UNAVAILABLE`로 거절한다(즉 잘린 수집을 인용하는 관측은 생길 수 없다). 이후 자식 프로세스 실행은 exit 0에 brief `item_count=0`으로 기권한다. 음성 증거를 실제로 기록하는 경로는 여전히 `migrations/028` 가드 때문에 행마다 고유한 `control_command_requests`가 필요하며, 이번 인수 범위에는 포함하지 않았다 |
| 원본 01–25 | 대부분 개발 checkout 구현 상태이며 production 적용이 아니다 |

전체 01–25 완료나 자비스·세컨드브레인 운영 완료를 선언하지 않는다. 위 잔여가 실제
충족된 뒤에만 그런 선언이 가능하다.
