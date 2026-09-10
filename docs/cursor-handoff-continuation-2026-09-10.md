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

전체 verify는 `b4df634`, `353b29b`, `61b3503` 시점에서 각각 exit 0으로 통과했다.
마지막 통과 실측: backend shard1 272파일/1861테스트, shard2 272파일/1899테스트,
dashboard 38파일/263테스트, 합계 582파일/4023테스트. architecture 655모듈/2434간선/
순환 0. 고정 시각 acceptance `pre_gjc_ready`, `aggregate_status=stopped`,
`completion_promoted=true`, `gjc_dispatched=false`. 증거 로그는
`/home/jm/.cache/jarvis-lineage-qa/`의 `verify.log`, `verify2.log`, `verify3.log`.
git에 포함되지 않는 로컬 증거이며, 다른 머신에서 접근할 수 없으면 재현해야 한다.

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
| B: cutoff 선정 표면과 opt-in service 연결 | 내구성 cycle fence와 중복 판정이 선행돼야 한다. fence는 이 문서 커밋 시점에 migration 088과 service 변경으로 작성되어 전체 verify 대기 중이며 아직 커밋되지 않았다. 자동 전체 task 등록은 하지 않는다 |
| B: 내용 기반 접수 dedup | 채택하지 않는다. 관측 식별자가 collection에 결속되므로 이전 관측을 재사용하면 cache 교체 즉시 영구 unavailable이 된다. 이는 "collection별 새 ID 요구를 제거해 중복을 숨기지 않는다"는 원본 지시와도 어긋난다 |
| C: provider receipt adapter | cap/완전성 결과와 provider release 식별자, refresh↔scoped request 매핑을 상대 과제와 합의 |
| D: 실제 업무 1건 인수 | 운영자가 대상 환경에 실행자 경로·검증 키 경로·키 ID를 설정 |
| 컴파일 daily CLI로 이 체인 구동 | 시각 매개변수화된 fixture 필요. CLI 창은 07:15 KST, fixture 시각은 21:00 KST 고정 |
| `capped` 수집 상태 | `negative_evidence` 행마다 고유한 `control_command_requests` FK가 필요 |
| 원본 01–25 | 대부분 개발 checkout 구현 상태이며 production 적용이 아니다 |

전체 01–25 완료나 자비스·세컨드브레인 운영 완료를 선언하지 않는다. 위 잔여가 실제
충족된 뒤에만 그런 선언이 가능하다.
