# OmO 잔여 내부 작업 실행 지시 2차 — 2026-09-13 (CODEX-JARVIS-FINAL-REVIEW-20260913-01)

감시 검토자(Claude Fable, 기존 감시 Codex 역할 대행)가 제출 후보 HEAD `0cca9c784b326d02f0fa3b421ded411243ac56e3` / tree `9aff8dd75ab4004b992add1221d449066ef5a14c`를 독립 읽기 검토한 결과다. `docs/omo-next-units-2026-09-13.md`와 master(`docs/claude-completion-instructions-2026-09-11.md`)를 대체하지 않고, 그 A–D 범위 안에서 **실측으로 확인한 내부 잔여**를 구체화한다. 판정: `REVIEW_REJECTED` → `IMPLEMENTING`. 구현·빌드·테스트·로컬 커밋 담당은 기존 OmO 단독이다.

제출물 중 확인된 사실(부정하지 않는다): 제출 gate 570파일/3,928테스트 rc=0, 로그 sha256 일치, 입력 HEAD/tree 일치, manifest 25개 산출물 sha256 전부 일치, tracked 변경 0. 이것은 "테스트가 통과한다"의 증거이지 아래 잔여가 없다는 증거가 아니다.

## 판정의 근거 — 왜 IN_PROGRESS이고 왜 A가 VERIFIED가 아닌가

**E1 (P1, CONFIRMED). 제품에는 추천을 생산하는 경로가 없다.** `produceDailyRecommendation`의 호출자는 `src/index.ts:251`(re-export)과 `scripts/packaged-production-chain-probe.mjs`(probe) 둘뿐이다. `daily morning` 명령(`src/cli-daily-commands.ts:60`)은 `createStoredMorningDailyLoop` → 단계 `refresh_context` → `morning_reconcile`(`src/daily-loop-morning-execution.ts:92`, `MorningBriefPublisher.publish`)이고, publisher는 `MorningRecommendationSource.generate`로 **이미 저장된** `personal_recommendations`를 읽는다. `ContextAssemblerInput`(`purpose: "daily_prioritization"`)을 만드는 src/ 코드는 0건, `rankPriorityActionsWithDeadlineEvidence` 호출자는 production.ts 하나, `Recommendations.create` 호출자도 그 하나다. 즉 "실제 assembler → 추천 → brief"는 테스트와 probe가 요청 객체를 손으로 만들어 넣을 때만 성립한다. master §7.1.3("제품 assembler→persist→추천 생성→발행 경로")과 §7.3("실제 configured service의 morning… 제품 handler와 프로세스 수준")의 종료 조건은 미충족이다. 이번 라운드가 처음 열었던 결함("src/ 호출자 0")이 한 계층 위로 옮겨졌을 뿐이다.

**E2 (P1, CONFIRMED). 생산 입력이 파생이 아니라 선언이다.** `DailyRecommendationRequest`는 `policy`, `principle_ref`, `owner_import_decision_ref`, `candidates`(owner_gate_ref, current_evidence_ref, stable_identity 포함), `recommendation`(id, actions, expires_at)을 **호출자가 선언**한다. 제품에는 관측→후보(candidates)를 만드는 생산자가 없고, 정책 문서를 읽어 `policy`로 넘기는 호출자도 없다. probe(`scripts/packaged-production-chain-probe.mjs:70` 부근)는 `trust: "user_confirmed"`인 memory를 fixture 입력으로 직접 넣는다 — B에서 만든 seam(`src/personal-memory-reference-evidence.ts`)을 거치지 않는다. 따라서 packaged "생산 체인" 인수는 seam도, 실제 생산자도 통과하지 않는다.

**F (P2, 사양 확정). §9.27 목적지 계약 단위는 내부 작업이다.** `claimRetentionOperation(staged)`는 이미 있으나 `src/local-observation-retention.ts:131` 이후 staged→목적지 rename이 남아 있고, `renameSync`는 비어 있는 기존 디렉터리를 대체한다. §9.27이 사양 1–5를 이미 적어 두었고 실측 영향(6파일 16건)도 알려져 있다. "소유자 결정"이 아니다.

**G (P2, 재분류). §9.23-1 배제 계약은 §9.30/§9.32 이후 코드가 이미 거절 기본값이다.** `exclusionHole`(`src/authority-database-process.ts:192`)은 unprovable이 있으면 `LOCAL_RETENTION_EXCLUSION_UNPROVABLE`/`MEMORY_EXCLUSION_UNPROVABLE`로 파괴 이전에 거절하고, 파괴 단계는 퇴거(rename)로 바뀌었다. 테스트는 `tests/fixtures/provable-exclusion.ts`의 **모의 허용 조건**으로 통과한다. 검토자가 이 호스트에서 실측: 같은 UID 프로세스 377개 중 `/proc/<pid>/fd`를 읽을 수 없는 것 16개 → 실제 retention/compaction 교체는 이 호스트에서 항상 거절된다(설계대로). 비특권 user namespace(`unshare -Urpf`)는 이 호스트에서 `uid_map` 쓰기 거부로 불가하므로 OS 격리 양성 인수는 이 호스트에서 만들 수 없다. 남는 소유자 결정은 "어느 사용자/경계에서 lane을 돌릴 것인가"라는 **배포 결정** 하나뿐이며, 그 앞의 준비물(상태 노출·preflight·운영안)은 내부 작업이다.

**H (P2, OmO 자체 측정 미해결).** 제출 보고가 "기존 `memoriesAwaitingTaskWithdrawal`의 content-identity 조인은 네임스페이스가 달라 target을 찾지 못한다"고 측정했으나 수정 커밋이 없다(`git log 3bff3ef..0cca9c7 -- src/memory-candidate-task-source.ts`는 50734ce 하나, 조인은 그대로). 이 함수는 M4.2-withdrawal-list의 VERIFIED 근거이므로, 측정이 맞다면 그 원장 항목은 실제 저장 경로에서 성립하지 않는다.

## E. 실제 생산 경로 결속 (P1)

1. **실패 회귀부터.** `tests/integration/daily-morning-cli-process.test.ts`·`tests/fixtures/compiled-daily-cli.ts`(실제 `dist/src/cli.js`, 고정 시계 wrapper)로: 격리 DB에 (a) `persistObservation`된 로컬 관측, (b) B의 양성 통제 경로(`stageCandidateDecision` → 소유자 서명 receipt → control plane 적용 → outbox dispatch·settle)로 만든 확인 기억, (c) 승인된 owner import receipt를 넣고 `daily morning --once`를 실행하면 **추천 1건이 생성되고 brief item에 실린다**를 단정한다. 지금은 실패해야 한다(추천 0, brief 기권). 같은 파일에 (c) 없는 경우 `PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED`(또는 정책 기권)로 추천 0·brief 기권·`personal_recommendations` 0행을 단정한다.
2. **제품 생산자.** 관측·기억·정책·후보·원칙/승인 참조를 **저장된 것에서 파생**하는 제품 모듈을 만든다. 호출자가 `candidates`/`policy`/`trust`를 선언하지 않는다.
   - 관측: `AuthorityDb`에 저장된 현재 로컬 관측(`context-assembler-sources`·`personal-context-evidence`의 기존 분류). advisory 로컬 관측을 live fact/owner decision으로 승격하지 않는다.
   - 기억: `src/personal-memory-reference-evidence.ts` seam이 돌려준 evidence만. fixture가 `trust`를 덮어쓰면 안 된다.
   - 정책: 제품이 이미 읽는 personal-os 정책 문서(`personal-os-policy*.ts`)와 그 decision ref.
   - 후보: 관측에서 파생한 후보 생성기(`stable_identity`/`current_evidence_ref`/`owner_gate_ref`를 관측·receipt에서 취함). 후보를 만들 근거가 없으면 빈 후보로 기권한다.
   - 원칙/승인 참조: control plane에 실제로 있는 승인·미철회·owner 서명 receipt에서만.
3. **daily loop 결속.** 생산은 `morning_reconcile` 안(publish 직전) 또는 새 단계(`produce_recommendations`)로 넣는다. 새 단계를 택하면 `daily-loop-morning-execution.ts:66-70`과 `cli-daily-commands.ts:110-113`의 `steps.length !== 2` 계약, `daily_loop_runs.input_json`의 step 목록, `assertDailyLoopIntegrity`를 함께 갱신하고 기존 daily 회귀가 왜 바뀌는지 커밋 메시지에 적는다. 기존 `automatic_operation: "hold"` 의미와 예산·lease·stale 검사는 유지한다.
4. **probe 재구성.** `scripts/packaged-production-chain-probe.mjs`는 fixture memory 직접 주입을 없애고 1의 경로(seam·control plane·daily CLI)로 packaged runtime에서 같은 두 갈래를 확인한다. `DailyRecommendationRequest`에서 선언형 필드를 제거하거나 내부 타입으로 내린다(export 유지 시 호출자 0임을 회귀로 고정).
5. **§7.2 재확인.** 새 경로로 같은 일자 재실행 idempotent(추천 중복 0), 재시작, hold/quarantine/expiry, capped 수집 → 기권, 출처 task 닫힘 → `RECOMMENDATION_MEMORY_SOURCE_CLOSED` 철회를 기존 harness로 통과시킨다.

통과 기준: 1의 두 회귀가 실제 `dist/src/cli.js` 프로세스로 통과하고, `grep -rn "daily_prioritization\|produceDailyRecommendation" src/`가 제품 호출 경로(daily loop)를 가리키며, fixture/probe가 `trust: "user_confirmed"`나 evidence kind를 직접 만들지 않는다.

## F. §9.27 목적지 계약 단위 (P2)

§9.27 사양 1–5 그대로. 통과 기준: 목적지 경로는 publish 이전에 **생성되지 않음**(회귀: 외부 프로세스가 미리 만든 빈 목적지 디렉터리가 있어도 대체·삭제되지 않고 운영이 `LOCAL_RETENTION_DESTINATION_INVALID`로 거절되거나 격리 이름을 쓴다 — 어느 쪽인지 사양에 적고 변이 검사로 고정), 급사 픽스처·일정·복구 회귀는 대장의 `candidate_path`를 읽는다, 영향 6파일 16건 전부 갱신, retention 스위트 전체 rc=0.

## G. 배제 계약의 내부 마감 (P2)

1. retention service(`src/local-observation-retention-service.ts`)와 memory compaction lane이 `EXCLUSION_UNPROVABLE`을 `blocked/deferred`와 구분되는 상태(예: `unprovable`, 판독 불가 pid 목록·개수 포함)로 보고하고, 같은 창 안에서 재시도하지 않는다. 회귀: 이 호스트의 실제 `/proc` 답으로 상태가 `unprovable`이고 소스·WAL·후보가 보존됨(§9.30의 거절 보존 인수 재사용).
2. `retention preflight`(또는 기존 `routing probe-runtime` 계열)로 판독 불가 pid 목록을 운영자에게 값으로 내는 명령 1개. 비밀·명령행은 출력하지 않는다.
3. `docs/local-retention-operations-proposal.md`에 배포 전제(전용 사용자 또는 PID namespace, 이 호스트 실측 16/377, `unshare -Urpf` 불가)와 운영자 결정 항목을 적는다. 이 결정만 `EXTERNAL_INPUT_REQUIRED`(operator)로 분류하고 나머지는 내부 완료로 닫는다.

## H. 저장분 철회 목록의 target 결속 (P2)

실제 settle 경로(B 양성 통제와 같은 fixture)로 저장분을 만든 뒤 `memoriesAwaitingTaskWithdrawal`이 그 저장분을 **null이 아닌 target**으로 열거하는 실패 회귀를 만든다. 조인을 settle 경로가 실제로 기록하는 identity(`memory_outbox.expected_page_id/expected_sid` 또는 saga가 쓰는 resolved target metadata)로 고친다. 측정이 틀렸다면 그 근거(어느 네임스페이스가 일치하는지)를 회귀로 고정하고 보고를 정정한다.

## I. 독립 읽기 검토 지적 — 단위 A 계열 (4a7898c·f4d4b66·fdf960e)

각 항목은 실패 회귀(지적한 시나리오 그대로) → 최소 수정 → 대상·인접 회귀 순으로 닫는다. 지적을 반박하려면 같은 시나리오를 회귀로 고정해 통과함을 보인다.

**I1 (P1, CONFIRMED). 승인되지 않은 `owner_gate_ref`가 기권이 아니라 미처리 throw로 끝난다.** `src/priority-engine-ranking.ts:79`는 `candidate.owner_gate_ref`를 검증 없이 인용에 복사하고 `:95`는 non-null만 검사, `:104-105`에서 `owner_gate_required`로 랭킹한다(`selectedLinuxFact` `:59-63`와 달리 `selected_refs`/`owner_decision` 사실 대조 없음). `src/personal-context-production.ts:157-158`은 rank가 있으니 기권 분기를 지나고 `:169` `recommendationEvidenceLinks` → `ownerDecisionLink`(`src/recommendation-evidence-binding.ts:135-136, 98-102`)가 `RecommendationEvidenceBindingError`를 던진다. `:144-173`에는 try도 트랜잭션도 없다. 시나리오: import decision은 승인, 후보의 `owner_gate_ref: "req:never-approved"` → context snapshot·evidence·observation link가 `:144`에서 저장된 뒤 throw. `abstained`도 `recommended`도 아니고 `PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED`도 없다. probe는 gate를 항상 승인해서(`probe.mjs:105`) 이 경로를 밟지 않는다. 통과 기준: 그 시나리오가 `abstained` + 명시 reason으로 끝나고 저장 범위가 사양대로(context만 또는 아무것도) 고정된다.

**I2 (P1, CONFIRMED). `user_confirmed_principle`이 저장된 컨텍스트가 증명하는 것이 아니라 호출자 선언이다.** `src/context-assembler-input.ts:104`가 요청의 `trust`를 받고, `src/context-assembler-sources.ts:68`이 `user_confirmed`만 남기고, `src/context-assembler.ts:65`가 `confirmed_memory`로 봉인하며, `src/personal-context-citation-contract.ts:162-164`(4a7898c)가 그 kind만으로 `user_confirmed_principle`을 부여한다. 같은 파일 `:114-118` 주석("trust를 지어내지 않는다… 호출자는 이것이 읽을 수 있는 곳에서 증명해야 한다")과 코드가 모순된다. 시나리오: 임의 sha256 digest에 `trust: "user_confirmed"`를 붙인 memory를 `assemble.memories`에 넣고 `principle_ref`로 가리키면 Second Brain 읽기·확인 기록·서명 없이 confirmed principle이 된다(`policyFacts` `:79-86`, `principleSources` `:121-130`). probe `:68-70`이 정확히 이렇게 한다. 통과 기준: confirmed principle은 seam(`personal-memory-reference-evidence.ts`)이 `trust: user_confirmed`로 돌려준 evidence 또는 그와 동등한 DB 확인 기록에서만 파생되고, 선언된 trust만 있는 입력은 `unconfirmed`/gap이 되는 회귀. E2와 같은 뿌리이므로 E와 함께 닫는다.

**I3 (P1, CONFIRMED). `approvedOwnerDecisionDigest`는 어떤 승인 요청이든 어떤 후보/원칙의 owner decision으로 받아들이고 만료를 보지 않는다.** `src/recommendation-evidence-binding.ts:82-97` 술어: request_id 일치, `decision='approve'`, digest 일치, 서명 principal의 purpose `decision`, 상태 approved/claimed/completed, 철회 행 없음. 없는 것: `a.expires_at`/`not_before`·`r.expires_at`·receipt `status` 대 now(`now` 인자 자체가 없음), 그리고 요청의 `action`/`args`와 후보·gate·원칙의 결속. `control_command_receipts.expires_at`(`migrations/021:33`)은 `ControlPlane.claim`(`src/control-plane.ts:105,120`)이 존중하는데 이 조회는 무시한다. 시나리오: 수개월 전 `workflow.start` 승인 하나(receipt 만료, 요청 completed)가 원칙의 `owner_import_decision_ref`와 무관한 deploy 후보의 `owner_gate_ref`로 동시에 인용돼 둘 다 수용(`production.ts:87-96`). fixture 자체가 `workflow.start`로 이렇게 한다(`tests/fixtures/fixture-authority.ts:73-83`). 통과 기준: (a) now 기준 유효 구간 검사, (b) receipt/request가 그 후보·원칙(action·target·args digest)에 결속됐는지 검사, (c) 만료·타 액션 receipt 시나리오가 gap/기권이 되는 회귀.

**I4 (P2, CONFIRMED/PLAUSIBLE). "아무것도 쓰지 않는다"는 부정확하다.** `production.ts:144`가 랭킹 전에 context를 저장하고 기권은 `:159`에서 반환한다(테스트도 기권 시 `stored.observation_count`를 단정, `personal-context-production.test.ts:63`). 보고 문구를 "context만 저장"으로 정정한다. 재실행: 동일 스냅샷만 replay(`personal-context-store.ts:66-69`), 시계가 다르면 새 context 행 + 호출자 고정 `recommendation.id`/`idempotency_key`로 `RECOMMENDATION_IDENTITY_CONFLICT`(`personal-recommendation-store.ts:82-85`, `recommendations.ts:101`)가 context 저장 뒤 미처리로 던져진다. 통과 기준: 같은 일자 재실행 idempotent 회귀(§7.2.1)가 E.5에 포함된다.

**I5 (P2, CONFIRMED, 기존 결함).** `linux_live_fact`도 생산자 경로에서 호출자가 만들 수 있다: `src/personal-observations.ts:97,127`이 `environment !== "mac-client"`인 어떤 `orca_tasks` 입력에도 `trust: "verified"`·`source_kind: "live_adapter"`를 찍고 검증 서명이 없다. `personal-context-store.ts:101-103`은 행 존재만 요구, `citationAuthorityForContext`(`contract.ts:95-101`)가 허가한다. probe `:53-66`의 "live Linux 관측"이 바로 이런 조작 입력이다. E.2의 관측 파생(실제 adapter 수집 경로)으로 닫고, 수집 경로 밖에서 만든 관측이 live fact로 인용되지 않음을 회귀로 고정한다.

**I6 (P3, PLAUSIBLE).** `src/morning-recommendation-record.ts:23-30`: `context_evidence_id: null`인 링크가 kind 무관하게 통과하고 `source_id`가 `context.source.source_id`(assembler)로 대체되어 brief가 control-plane receipt를 assembler 출처로 인용한다. provenance 정확성 수정.

검토가 맞다고 확인한 것: retention hold 규칙 변경(`local-observation-retention-selection.ts:97-100,126`)은 만료된 비로컬 인용만 hold를 잃고, assembler(`context-assembler.ts:75-80`)·`recommendations.ts:138`의 만료 경계 때문에 미만료 context/추천이 퇴거되지 않는다. fixture는 추천/context/brief 테이블에 직접 INSERT하지 않는다. 다만 `tests/fixtures/local-observation-chain.ts:166-200`은 assembler를 우회해 `ContextSnapshotV1`을 손으로 만들어 `persistContextSnapshot`하고 `:131-139`,`:211-214`와 `recommendation-fixture.ts:130-185`는 `evidence_class`(owner_decision 포함)를 엔진 입력으로 손으로 선언한다 — E 이후 이 fixture들은 제품 생산자 경로로 옮기거나 "엔진 단위 fixture"로 명시 분리한다.

## J. 독립 읽기 검토 지적 — 단위 B 계열 (50734ce·22f414a·19d337f·393bfeb·ba98ca6·1b00d00·0cca9c7)

**J1 (P1, CONFIRMED). 발행된 morning brief 읽기는 닫힌 기억 검사를 적용하지 않는다.** `src/dashboard/personal-today.ts:112-115` `briefSummary`는 `recommendationsWithUnavailableLocalSource`만 거르고 `contextsWithClosedMemorySource` 상당이 없다. 시나리오: 07:00 발행된 brief의 항목이 파생 기억 M에 기대고, 09:00 소유자가 M의 task를 숨김 → 10:00 `GET /today`는 여전히 그 항목을 현재로 보고(`item_count` 포함)하면서 같은 추천의 projection은 `RECOMMENDATION_MEMORY_SOURCE_CLOSED`다. 통과 기준: 소비자 전수(context 조립·추천 projection/read·brief read·dashboard personal read/details/lists·timeline)가 같은 판정을 내리는 회귀 1개(하나의 fixture에서 각 표면을 읽어 동일 결과 단정).

**J2 (P1, CONFIRMED). 실행 경로는 추천이 철회됐는지 묻지 않는다.** `src/recommendation-workflow-staging.ts:69-115`·`verifyRecommendationWorkflowBinding`(`:112`)·`loadRecommendationWorkflowAuthority`(`src/recommendation-workflow-authority.ts:100-190`)는 digest·lifecycle ELIGIBLE·만료만 검사하고 `contextsWithUnavailableLocalSource`/`contextsWithClosedMemorySource`를 보지 않는다(호출자는 `morning-recommendation-source.ts`와 `recommendation-projection.ts`뿐). 시나리오: 추천 R이 task T의 기억에 기댐, T 숨김 → `workflow.start` for R rank 1 스테이징·승인·실행이 통과. 통과 기준: staging·binding 검증·executor 모두에서 철회된 추천이 `RECOMMENDATION_MEMORY_SOURCE_CLOSED`(또는 unavailable)로 거절되는 회귀, 이미 승인된 명령의 실행 직전 재검사 포함.

**J3 (P2, PLAUSIBLE). 닫힌 기억이 새 저장 context에 다시 저장된 뒤에야 닫힘을 묻는다.** `production.ts:143-146`: assembler가 `trust: "user_confirmed"`를 `confirmed_memory`로 봉인(`context-assembler.ts:61-69`) → `persistContextSnapshot`이 `personal_context_memory_evidence` 행을 씀 → 그 뒤 `citationAuthorityForContext`가 `closed_task_source`. 매일 실행마다 소유자가 닫은 기억의 저장 사본이 늘어난다(`memory-task-closure-reuse.test.ts:192`가 이를 확인). E의 생산자에서 접수 시점(assemble 입력 구성)에 닫힌 task의 기억을 제외하고, 저장 전 차단 회귀로 고정한다.

**J4 (P1, CONFIRMED 설계 공백). 닫힘 조인은 호출자가 쓰도록 강제되지 않는 content digest에 기댄다.** `derivedMemoryTaskClosed`(`memory-candidate-task-source.ts:83-93`)는 `personal_context_memory_evidence.evidence_digest`와 `memory_candidates.content_digest`를 맞춘다. 그 digest를 넣는 유일한 제품 경로 `contextMemoryFromReference`(`personal-memory-reference-evidence.ts:81-85`)는 src/ 호출자 0(`index.ts:253` export뿐). provider 레코드 identity(`content_identity_full`, ba98ca6 메시지대로 "다르게 계산됨")로 `MemoryInput.digest`를 만든 호출자는 영원히 일치하지 않아 닫힘이 발화하지 않는다. E에서 seam→assemble 입력 결속을 제품 코드로 연결하고, seam 밖에서 만든 `confirmed_memory`가 인용될 수 없음을 회귀로 고정한다(I2와 동일 뿌리).

**J5 (P2, PLAUSIBLE). `ownerConfirmedContent`(`personal-memory-reference-evidence.ts:37-51`)는 settled 후보가 아니라 같은 content의 모든 후보를 조인한다.** 시나리오: 후보 X(content C, task T1, required_confirmation=1, 소유자 확인)와 후보 Y(content C, task 없음, required_confirmation=0, 자동 스테이징, page P에 settled). P의 레코드 → `settledCandidateFor`→Y, `candidateTaskSourceClosed(Y)`=false, `ownerConfirmedContent(C)`=true(X 경유) → 소유자가 확인하지 않은 쓰기에서 `user_confirmed` evidence. T1을 뒤에 숨겨도 seam은 evidence(Y만 물음). `memory_candidates.state`·`memory_projection_suppressions`도 X/Y에 대해 검사하지 않는다. 통과 기준: 확인은 settled 후보 자신(또는 그 후보에 결속된 확인)에서만 인정하는 회귀 + 위 X/Y 시나리오가 gap.

**J6 (P3, PLAUSIBLE). `settledCandidateFor`(`:24`) `LIMIT 1` without `ORDER BY`, `(expected_page_id, expected_sid)` 비고유.** `requireMemoryOutboxAuthority`가 `expected_artifact`를 `memoryRememberArtifact`와 대조하지 않는다. 두 settled 후보가 한 page/sid를 가리키면 비결정적. 고유 제약 또는 명시 거절(복수 매치 → gap `ambiguous`)로 고정.

**J7 (P2, CONFIRMED 커버리지). "IO 후 재검사" 회귀가 없다.** `memory-task-closure-reuse.test.ts:156-162`는 provider read를 await한 뒤 결과를 버리고 `:164-170`에서 memory를 손으로 만든다. seam 테스트(`memory-reference-context-seam.test.ts:83-94`)는 동기이며 provider IO가 없다. "IO 시작 → 숨김 → 반환 레코드 → seam → unavailable"을 실제 비동기 reader로 구동하는 회귀를 만든다(E.2의 seam 결속 이후 가능).

**J8 (P3, CONFIRMED).** `morning-recommendation-source.ts:96-102`가 닫힘을 `excluded.source_unavailable`로 집계(`memory-task-closure-reuse.test.ts:120`이 단정) — 22f414a의 "source-unavailable 코드를 빌리지 않는다"와 모순. 별도 집계 키.

**J9 (P3, 참고).** `contextsWithClosedMemorySource`(`personal-memory-availability.ts:13-27`)는 인용된 기억이 아니라 결속된 어떤 기억이든 닫히면 철회한다. fail-closed이므로 문서화만.

**J10 (P2, CONFIRMED 형제 결함).** 19d337f는 `principles.length===0`만 기권으로 바꿨고 `candidates.length===0`(`priority-engine-input.ts:202`)은 여전히 throw. E의 후보 파생에서 후보 0이면 기권으로 처리한다. `policyFacts`가 `[]`를 반환해도 `context-policy-input.ts:163`이 받아들이므로 최소 사실 조건을 사양에 적는다.

**J11 (P2, CONFIRMED). 양성 통제의 dispatch는 손으로 만든 action이다.** `memory-reference-positive-control.test.ts:67-75`는 `prepareMemoryRememberDispatch`/`stageMemoryRememberDispatch`(`memory-remember-dispatch.ts:12-33`, `hasSecondBrainWriteAuthority`·artifact 파생 강제)를 우회해 시험 선택 목적지 `wiki/example-alpha`/`12345678`을 직접 스테이징하고 FixtureReader가 같은 page를 돌려준다. 확인·서명·control plane 적용·saga settle은 실제다. 통과 기준: dispatch도 제품의 prepare/stage 경로로 만들고 seam이 그 파생 목적지로 결속됨을 단정.

검토가 맞다고 확인한 것: `closed_task_source` 발화(`contract.ts:159-161`, 두 닫힘 사유 `memory-candidate-task-source.ts:91`), 기록 보존·철회·별도 경고(`recommendation-projection.ts:178-194, 223-226`, `owner_decisions_needed`는 `current`에서 파생), 생성 경로의 DB 재파생 대조(`binding.ts:119-149`), `required_confirmation=0` settled 단독 거절(`ownerConfirmedContent`는 `decision='confirm'`+applied+owner 서명+미철회 요구, decision 행은 `memory-surface-authority.ts:130`만 씀), 391 migration 091 immutable PK. 393bfeb의 재시작·scope·rebuild·철회는 제품 경로이나 설정은 fixture 수준(`recordCandidateTaskSource` 직접 호출, `trust:"user_confirmed"` 선언 context) — E 이후 접수 경로로 옮긴다. migration 091 이전 후보는 task 행이 없어 영원히 닫히지 않는다(backfill 없음): 사양에 "결속 없는 후보는 미영향"을 명시했으므로 원장에 그 한계를 적는다.

## D 갱신

- 원장 A를 `IN_PROGRESS`로 되돌리고 근거를 E1/E2로 적는다. §9.23 두 항목은 F/G로 재분류한다(감시 검토자의 판단이며 OmO가 임의 재분류한 것이 아니다).
- 단위마다 실패 회귀→최소 수정→대상·인접 회귀→로컬 커밋. 전체 gate는 E–H가 모두 끝난 **고정 입력 1회**. 패키지·pin·probe는 최종 코드로 재생성. manifest에 이 문서 sha256과 검토 receipt 경로를 넣는다.
- 이 문서를 `docs/omo-next-units-2-2026-09-13.md`로 복사해 D 커밋에 포함한다(감시자는 제품 checkout에 쓰지 않는다).

금지 사항은 기존과 같다: push/merge/deploy/서비스 재시작/운영 DB·설정·current 변경/운영 credential·authority 생성/타 작업 산출물 삭제. 살아 있는 gate 입력 변경·전체 gate 중복 실행 금지. 단위 PASS/커밋/후보 제출은 종료 조건이 아니다.
