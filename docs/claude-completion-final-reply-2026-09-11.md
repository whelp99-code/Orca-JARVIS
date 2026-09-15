# 최종 검증 회신서 — 2026-09-11

> **현재 판정 — 2026-09-15 R4 (운영 활성화):** 상태는 `ACTIVATED_WITH_EXTERNAL_INPUT_REQUIRED`. 아래 R3 이하 블록은 당시 기록이다.
>
> - 릴리스 라인: `integration/routing-approval-ui-main` (= main). 활성 authority 릴리스 `c4a2487…` (이전 `ac54426…`도 동일 절차로 활성화됨), control-center `artifact-4cbfbae5…`. gate 9차 rc=0 638파일/4,414테스트 (`/home/jm/.cache/jarvis-integration-20260915/gate-result-run9.json`). 패키지 receipt pin `03cf4f0f…`, 예행 receipt 0 pending, 사전·사후 gate 9/9, 백업 3건(활성화 전후).
> - 운영 DB migration 81→103 적용(ac54426 재시작 시 22개). Second Brain config에 공개키 테이블 3개 적용(`.bak-20260915T094022Z`). drop-in `20-task-executor.conf`, `30-memory-effect.conf` 설치.
> - M5: 소유자 서명 workflow.register/start/task-execute 3건 `completed`, 실행자 커밋 `a7b2222`(스크래치 repo), 독립 verifier `jm-verifier-root-v1` 서명 검증 (`/home/jm/.cache/jarvis-m5-20260915/RECEIPT.md`).
> - 대시보드 Second Brain readiness: `degraded`(read_only, refresh receipt 없음). 남은 외부 입력: provider의 `daily-refresh-receipt-v1` 발행과 비파괴 write-authorization 표면, retention lane 전용 사용자 provisioning(operator), Codex CLI 재로그인(operator). 이 넷이 닫히기 전에는 전체 완료가 아니다.


> **현재 판정 — 2026-09-15 R3:** `IN_PROGRESS`. 아래 2026-09-14 R2-1 이하 모든 블록은 **당시 기록**이며 삭제하지 않는다. 이 블록이 현재다.
>
> **통합 branch(실측):** `integration/routing-approval-ui-main` = `codex/routing-approval-ui` + `main@8745ce7` + `feat/withdrawal-effect` + `feat/release-gaps` + `feat/real-provider-chain` + `feat/unit-a-service-production`. HEAD `93783fb`, tree `b2be8c70`. 전체 gate run 4 rc=0, 635파일/4,387테스트, `2026-09-15T05:15:26Z`→`05:43:33Z`, 로그 sha256 `223a1c47e3f3ae34921ec8e6f8f6e65bd6d70c9ec4ddaa0646f3f280312ec327`(`/home/jm/.cache/jarvis-integration-20260915/`). 제외: run 1 rc=1(기존 main 결함), run 3 rc=1(build-metadata strict schema, `93783fb`로 수정).
>
> **A:** `VERIFIED` — 독립 재리뷰 `/home/jm/.cache/jarvis-codex-claim-review-20260911-4ztfcjp6/monitor-repair-20260913T0601/unitA-promotion-review-20260915-r2.md`(B1 `91c92c2`, B2 `dcad4df` — 격리 관측 fail-open 수정 포함, B3 `7be40f0`, `f2fc866`). 실 provider probe receipt `/home/jm/.cache/jarvis-real-provider-20260915/probe-receipt.json`(생산 1/1, 그 외 0), `d3ca9e1`, `daily morning --once` 커버; `service once`는 gate 내 커버.
>
> **B:** `VERIFIED` — 양성 통제가 이제 제품의 prepare/stage dispatch 경로를 실제로 통과(`ad1299b`), IO 중 숨김 회귀(`fbed510`), 모든 reader 일치(`caa68c1`/`920b574`/`7ec72be`/`8638f48`), settle된 후보에 결속된 seam 확인(`5bd9c52`).
>
> **M4.2-withdrawal-effect:** 내부, `VERIFIED` — provider 계약 `sb_resolve_memory_target`은 이미 존재(`contracts/second-brain-mcp-v5.json`); JARVIS adapter `src/memory-withdrawal-effect.ts` + CLI `memory withdrawals`/`memory withdraw-prepare`(`f565b40`, `288528d`, `3d65b38`, `3f11aa1`); 남은 것은 provider 쪽 증명 관측(reconcile → settled) 하나뿐.
>
> **격리 Second Brain 설치:** 완료, `/home/jm/.cache/jarvis-isolated-second-brain-20260915/RECEIPT.md`(release `2ccf0267…` 최신 운영 release와 byte 일치; 모든 read 메서드, write settle, scope, generation, cancellation을 provider 서명 결과로 확인; 격리 유지).
>
> **실 provider 격차 수정(`feat/real-provider-chain`):** probe가 `JARVIS_SECOND_BRAIN_LAUNCHER`/`CONFIG`를 따름, memory-effect 서명 키 provisioning(`MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED` fail-closed), lexical query 정규화, daily config v3 `morning_local_time`, provider result-key preflight.
>
> **릴리스 도구(`feat/release-gaps`):** gate CLI들 + `release gates`, `release rollback`, `db migrate --rehearse`, 검증자 principal을 고정 anchor에서 파생(`JARVIS_TASK_VERIFIER_KEY_ID`), `publish-package-release.sh` + sealed manifest; 후속 branch `feat/release-gaps-2`(진행 중)는 gate phase, publish 순서/unpublish, production-root rollback, backup restore를 추가.
>
> **lane 배포 경계:** 결정 기록됨 `/home/jm/.cache/jarvis-ops-decisions-20260915/DECISION-lane-boundary-20260915.md` — 기본 거절 유지; 활성화는 전용 service user가 필요(동일 UID 프로세스 17개 관측 불가로 실측); 운영자 provisioning = `EXTERNAL_INPUT_REQUIRED`(operator).
>
> **남은 외부/운영 항목:** M5 실행자 env(기존 `jm-verifier-root-v1`을 새 규칙 아래 사용 가능; env drop-in + probe + 승인 업무 1건 실행이 운영 단계로 남음); 프로덕션 릴리스 활성화 대기(`RELEASE-EXEC-PLAN-20260915.md`); Second Brain 프로덕션 config에 `[provider_result_public_keys]`/`[jarvis_public_keys]` 및 release 활성화 필요; Codex CLI 재로그인(`CODEX-RECOVERY-20260915.md`).
>
> **상태:** 활성화와 M5 업무 실행이 이루어지고 receipt로 확인되기까지 `IN_PROGRESS`. `deployment_ready`는 그때까지 `false`.


> **현재 판정 — 2026-09-14 R2-1 정정:** 상태는 `IN_PROGRESS`다. 아래 2026-09-13 09:5x 블록과 그 이전은 **당시의 것**이며 삭제하지 않는다. 이 블록이 현재 판정이다.
>
> A는 `IN_PROGRESS`다. 근거는 최종 리뷰 E1/E2다. 2026-09-13 표·문단의 A=`VERIFIED` 또는 “A·B·C의 내부 잔여는 닫혔다”는 당시 기록이다.
>
> §9.23 두 항목(동일 UID `/proc` 한계, 목적지 rename no-replace)은 F/G 커밋 `350efa0`·`7241511`로 이 라운드에서 닫혔다. 2026-09-13 09:5x 문단의 “이 라운드의 작업이 아니다”는 그 닫힘 이전 기록이다.
>
> B·M3·M6를 round2 619/4213으로 `VERIFIED`로 올리지 않는다. 외부 4건(격리 Second Brain, M5 키 3개, M4.2-withdrawal-effect provider 계약, lane 배포 경계)은 검증자가 닫지 못한다.

> **현재 판정 — 2026-09-13 09:5x UTC 갱신:** 상태는 여전히 `IN_PROGRESS`다. 아래 2026-09-13 초기 판정과 그 이전 기록은 **당시의 것**이며, 이 블록이 현재 판정이다. 과거 §0/§4의 "A/B 모두 닫힘", "환경 한계만 남음" 문구는 현재 상태가 아니다.
>
> **기준값(실측):** 제품 branch `codex/routing-approval-ui`. tracking branch 미설정이라 ahead/behind는 측정할 수 없다. tracked 변경 0, untracked 3(`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules` — 도구 상태·공유 의존성, 커밋 대상 아님).
>
> **이 라운드에 닫은 것(각각 실패 회귀 → 최소 수정 → 대상·인접 회귀 → 로컬 커밋):**
> | commit | 무엇을 고쳤나 | 인접 증거(실제 RC) |
> |---|---|---|
> | `4a7898c` | owner decision을 컨텍스트가 아니라 **승인된 control-plane receipt**에서 파생. assembler는 `owner_decision`을 만들 수 없는데 priority engine은 모든 랭킹 액션에 그것을 요구했으므로, owner-gated 액션은 실제 경로로 바인딩 자체가 불가능했다 | 전체 gate rc=0, 566파일/3,915테스트 |
> | `f4d4b66` | 생산 진입점 `produceDailyRecommendation`. 이전까지 `assemblePersonalContext`·`persistContextSnapshot`·`Recommendations.create`의 `src/` 호출자가 **0**이었다 | 58파일/477테스트 rc=0 |
> | `50734ce` | 닫힌 task의 파생 기억을 인용 불가(`closed_task_source`)로 | 78파일/667테스트 rc=0 |
> | `22f414a` | 이미 만들어진 추천을 현재 작업에서 철회하되 **기록은 보존**, 이유를 `RECOMMENDATION_MEMORY_SOURCE_CLOSED`로 구분 | 129파일/1,050테스트 rc=0 |
> | `19d337f` | 인용할 원칙이 없을 때 생산자가 무효 입력을 만들어 엔진이 거부하던 것을 **engine 자신의 gap**으로 보고하도록 | 236파일/1,752테스트 rc=0 |
> | `393bfeb` | 재시작·project scope 변경·restore rebuild·승인 취소에서의 재유입 차단을 회귀로 고정 | 대상 7건 rc=0 |
> | `ba98ca6`→(seam 갱신) | provider 반환 레코드를 실제로 소비하는 경계. 세 조건(설정된 destination, task 미폐쇄, 소유자 확인)을 **이 데이터베이스에** 묻고 하나라도 없으면 gap | 203파일/1,583테스트 rc=0 |
> | `fdf960e` | packaged runtime 안에서 관측→context→추천→brief를 실행하는 probe | probe rc=0 |
>
> **전체 gate(1회, 고정 입력):** 입력 HEAD `181aff2252a04f109fb3e2a202363e974fbd9331`, working tree digest `sha256:713d3a663641f3cef6f22ee1b4d94e334657127bfb2bafbc101e00b8b79f4a77`(변경·신규 46파일 각각 sha256 포함). 실행 rc=0, 566파일/3,915테스트, 07:07:11Z→07:33:18Z, pid 3704380, 로그 `sha256:885187f6132e22ba4088f0fbb2713fb8a0ebbb6b4a0bae9c81f695643df1f65a`. 그 이전 1차 시도는 런처 세션의 kill 마감으로 **중단**돼 RC가 없으며(로그 8,484바이트/99줄, 요약줄 없음) 합격 근거에서 제외했다.
>
> **패키지:** packager rc=0. receipt `sha256:dd10558ccaeb135fdd2d97d82588816fb722e751e03c873d843526e43de4558a`를 **검증 이전에** 독립 QA에 고정했고, 두 검증(대시보드 HTTP probe, 생산 체인 probe) 이후 재측정해도 동일했다 — 기대값을 패키지 자신에게서 재생성하지 않았다. packaged runtime에서 owner 승인이 있을 때 추천 1건이 projection·brief에 실리고, 없을 때 `PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED`로 기권하며 아무것도 쓰지 않는다. `deployment_ready=false` 유지. receipt의 `dirty:true`는 `git status --untracked-files=all` 기준이며 tracked 변경은 0이다.
>
> **B 양성 통제 — 2026-09-13 닫힘:** provider가 돌려준 레코드가 **소유자가 확인한** 기억으로 context에 들어가는 경로를 회귀로 고정했다. 대시보드가 쓰는 `stageCandidateDecision`으로 확인을 스테이징하고, 소유자가 서명한 receipt를 control plane이 적용하고, 그 후보를 실제 outbox saga로 dispatch·settle한 뒤, 같은 reference가 gap이 아니라 `trust: "user_confirmed"` 증거가 된다. 이제 seam은 네 가지를 변별한다 — 이름 댈 수 없는 identity(거절), 확인 없는 settled 쓰기(거절), IO 중 숨김(거절, `unavailable`), 그리고 실제 소유자 확인(수용).
>
> **상태를 올리지 않는 이유(이 라운드의 작업이 아니다):** A·B·C의 내부 잔여는 닫혔다. 남은 것은 이전 라운드가 §9.23에 측정해 둔 두 항목이다 — (1) `/proc`로 관측할 수 없는 동일 UID 프로세스 문제는 그 문서가 스스로 "소유자/운영 결정 필요"라고 적었고, 구현해 보니 이 호스트에서 교체가 항상 거절되어 기존 인수 16건이 깨졌다. (2) 목적지 rename을 no-replace로 바꾸는 변경은 6파일 16건이 실패하는 독립 단위다. 남의 측정 판단을 이 라운드에서 임의로 재분류하지 않는다.
>
> **외부 잔여:** 격리된 Second Brain 설치물/프로세스. 이 호스트의 유일한 설치물은 운영용이며(살아 있는 vault 심볼릭, 당일 기록된 generation journal, request-executor 활성, 철회 lock), 제품의 launcher 상수가 `app/current`를 가리킨다. 운영 경로를 건드리지 않고는 실행할 수 없어 실행하지 않았다. 계약 표면 자체는 제품의 harness로 41파일/382테스트 rc=0으로 인수했다.


> **현재 판정 — 2026-09-13:** 전체 M0–M6은 `IN_PROGRESS`다. close 경계 유실 결함은 제품 `18b73ede9a369ae8cb34bb44885bf6cbef9f2687`에서 수정했고, 정확히 동일한 tree `222cfb394e897ae4db25f322a32789c6e9cb4046`의 전체 verify가 604파일·4,176테스트/RC0으로 통과했다. 첫 실패/중단 run은 제외했다.
> 최신 검증·패키지·독립 리뷰는 [2026-09-13 수정 검증서](codex-close-fence-verification-2026-09-13.md), 실제 내부 잔여 A–D는 [OmO 실행 지시서](omo-next-units-2026-09-13.md)가 정본이다. 이하 과거 SHA·gate·잔여 표와 “A/B 모두 닫힘/환경 한계만 남음” 주장은 당시 기록이며 현재 완료 판정으로 사용하지 않는다. 실제 assembler 생산 연결·저장 기억의 현재 사용 차단·최종 packaged 프로세스 인수는 아직 내부 잔여다.


## 0. 최종 상태

**`IN_PROGRESS`.**

다섯 번째 검토가 열어둔 항목이 남아 있으므로 완료 쪽으로 올리지 않는다. 이 라운드에서 검토는
다섯 번 있었고 **다섯 번 모두 실제 결함을 찾았다.** 그 사실이 이 문서의 상태를 정한다.

이번 검토에서 닫은 것:

- 배리어 소유를 **프로세스가 아니라 발행 단위**로 바꿨다. 같은 프로세스의 두 번째 운영이 살아 있는
  배리어를 대체하거나 남의 배리어를 해제할 수 없다(`ffb2509`).
- 배리어 경로에 **레코드로 읽을 수 없는 객체**(링크·디렉터리·파이프)가 있으면 영구 거절되던 것을,
  잠금 아래에서 **옆으로 옮겨** 회수 가능하게 했다. 지우지 않는다.
- 디스크립터 관측이 **읽지 못한 프로세스를 보고**한다(`unprovable`).

이 표 이후 gate가 깨끗한 환경에서 RC 0으로 통과했고(§9.25) 패키지도 검증됐다(§9.26). 그래도 상태를
올리지 않는 이유는 아래 1·2번이 여전히 **설계 결정 대기**이기 때문이다.

아직 열려 있는 것 — 각각 무엇을 측정했고 왜 아직 닫히지 않았는지는 §9.23에 있다:

| # | 항목 | 상태 |
|---|---|---|
| 1 | `/proc`로 관측할 수 없는 프로세스가 유휴 연결을 쥔 경우 | 요구대로 "증명 불가 시 거절"을 구현해 실행했더니 **이 호스트에서 모든 교체가 항상 거절**되고 기존 인수 16건이 실패했다. 되돌렸고, 이 항목은 **배포 경계 결정**(전용 사용자/PID namespace)이 필요하다 |
| 2 | 목적지 rename이 no-replace가 아님 | 목적지를 아예 만들지 않는 형태로 바꿔 실행했더니 6파일 **16건**이 실패했다 — retention 경로 계약 전체를 함께 바꾸는 독립 단위임을 측정했다. 다음 단위의 작업으로 둔다 |
| 3 | 복구의 나머지 삭제 경로가 격리 이동을 쓰지 않음 | 남아 있다 |
| 4 | 격리 이름이 대장에 기록되지 않아 크래시 시 고아가 될 수 있음 | 남아 있다 |
| 5 | `memory-candidate-scope`의 제안 경로가 task 게이트를 거치지 않음 | 남아 있다 |

> **2026-09-12 갱신 (§9.28 정본).** 이 시점의 상태는 `IN_PROGRESS`다. 제품 SHA는
> `0001763f71d99acb897bb0b0bbdaf7baa33895d2`, 전체 gate `VERIFY45=0`, 패키지 `jarvis-runtime-efkBcB`
> (`integrity=matched`, `deployment_ready=false`), manifest `gate_input_sha=0001763…`.
> **닫힘:** 기존 목적지 보존(REVIEW-01) — 목적지를 생성·점유·교체하는 경로 자체를 제거했고 세 형태 모두 회귀로 고정.
> **열림:** writer 배타성(REVIEW-02/-03) — `b4927fb` 는 창을 좁혔을 뿐 봉쇄하지 않으며, 증명 불가 환경의 거절은
> 두 구현을 만들어 측정한 결과 각각 "항상 거절" 과 "타이밍 의존 거절" 로 무너져 되돌렸다(§9.28). 남은 해법은
> 관측이 아니라 admission 프로토콜이며, 특권 프로세스는 계약의 명시된 한계다.

## 1. 기준 SHA와 트리 실측

> **현재 기준 (2026-09-12 갱신).** §1 의 아래 표는 다섯 번째 리뷰 시점(`c2e191a`)의 기록이며 그대로 보존한다.
> 지금 검증된 제품 SHA·gate·패키지는 §0 갱신 블록과 마지막 §9 절이 정본이다. 그 사이의 모든 gate 와 패키지는
> 각각 자기 절에 자기 SHA 로 기록돼 있고, manifest 의 `gates[].package_root` 는 각 항목의 `input_sha` 와
> receipt `source.head` 가 일치하도록 실측으로 맞춰 두었다.

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| 제품 검증 SHA (전체 verify 입력) | `c2e191ab54f657cf5743bea3d8af565895474560` |
| 검증 시점 tree | `git rev-parse f1e6b14^{tree}`로 확인 가능. 문서 포함 제출 HEAD는 아래 |
| 문서 포함 제출 HEAD | 이 회신서를 담은 문서 커밋. 제품 SHA 이후의 차이는 `docs/`만이어야 하며, 확인 명령은 `git diff --name-only <제품 SHA>..HEAD`다 |
| upstream | `not_configured` — ahead/behind 측정 불가 (`git rev-parse --abbrev-ref @{u}` 실패) |
| tracked 변경 | M 0, D 0 |
| untracked | 3 (`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules`) — 도구 상태·공유 의존성, 커밋 대상 아님 |
| 베이스라인 대비 | `082d689..4518103` 39 커밋 (문서 커밋 별도) |
| dashboard 파일 변경 | 2 (`src/dashboard/memory-candidate-review.ts`, `src/dashboard/memory-candidate-decision-staging.ts`). 프런트엔드 `dashboard/` 번들은 0이며, 바뀐 것은 백엔드 read/staging 경로의 후보 게이트 한 줄씩이다 |

packager가 `source_dirty: true`로 기록한 것은 위 untracked 3건 때문이며, tracked 수정은 0이다.

## 2. 커밋 목록과 각 단위의 이유

| SHA | 종류 | 이유 |
|---|---|---|
| `92e2e5a` | 제품+테스트+문서 | R2 P1-A/P1-B 수정. 후보를 복사기 자신의 plan으로 양방향 대조하고, 원본을 snapshot에 고정한 뒤 선정·복사·검증을 모두 그 snapshot에서 수행 |
| `ea4f538` | 제품+migration+테스트+스크립트+문서 | M2. 운영 기록(089)·소유 증명·복구·quiesce 교체·일정 fence(090)·용량 실측 스크립트·운영자 제안서 |
| `0d6d614` | 제품+테스트+문서 | M3 인용 계약. assembler 증거를 출처 기반으로 분류해 advisory 로컬 관측의 승격을 차단 |
| `200f9f7` | 제품+테스트+문서 | M4.1. provider refresh receipt의 fail-closed 파서·버전 협상, `provider_refresh`를 상수에서 저장된 단계 기록으로 전환, provider 인계 bundle |
| `037ab03` | 제품+migration+테스트+문서 | M4.2 결속. 후보↔원본 task 결속표(091)와 접수 거절, 검토·쓰기 차단 전파 |
| `af708be` | 테스트+문서 | 같은 gate가 scoped 등록과 전송 중 경로도 막는다는 사실을 단정으로 고정 |
| `3da7272` | 테스트+문서 | rebuild 동반 제거와 백업 복원 재유입 0을 고정. 정제기에 임시로 넣었던 규칙은 복사기가 이미 처리함을 실측하고 되돌림 |
| `453bd48` | 제품+테스트+문서 | 숨긴 task가 provider에 남긴 저장분을 열거하는 surface. 철회 자체는 쓰지 않음 |
| `3e94d17` | 제품+테스트+문서 | 후보 생성 뒤 원본을 숨겼을 때, 미리 준비된 승인의 확정을 차단(실제 구멍이었고 검사를 빼면 회귀가 실패함) |
| `128d290` | 제품+테스트+문서 | 철회가 지목할 resolved target을 목록에 실음. 저장 전이면 null |
| `49783df` | 문서 | 운영 디렉터리 도입분의 재제출과 receipt 정정 |
| `4518103` | 제품+테스트+문서 | 교체 구간의 프로세스 간 배타성(§9.2). 공유 swap 배리어와 단일 open 경계의 입장 통제, 파괴 이전 거절, 확보 대장이 남긴 두 결함(죽은 intent 상속·source 쓰기 계약 2→5) 정리 |

과거 gate 결과를 새 코드에 소급하지 않았다. `0af1025`까지의 gate는 그 시점의 기준점으로만 유효하고,
§6의 전체 verify는 이 회신서가 제출하는 제품 SHA `4518103` 입력으로 다시 실행했다(§9.4).

## 3. R2 반례 before/after

“before”는 리뷰어가 각 회신서에 기록한 실측이고, “after”는 이 트리의 정식 회귀다.

| 반례 | before | after (고정 회귀) |
|---|---|---|
| 감사 행 3→2 (P1-A) | 차단 context를 인용한 감사 행이 후보에서 사라져도 통과 | `retention-plan`: “rejects a candidate that lost an audit row naming a removed context” |
| 값 경계 충돌 (P1-B) | `r s:/foo`+`/bar` 와 `r`+`/foo s:/bar` 가 같은 키 → 변조 후보 통과 | `retention-plan`: 값 구별 7케이스(구분자·인용부호·빈 문자열·NULL·blob·수치·큰 정수) |
| 허용하지 않은 작업 누락 | ATTACH ABA에서 선정 0건인데 원본 작업 1건이 후보에서 소실, 재검증 통과 | `retention-consistency`: “ignores a source swapped around the adapter's attach and keeps the unselected work” |
| 선정된 제거 대상 잔존 | — | `retention-plan`: “rejects a candidate that kept rows the selection chose to remove” |
| FOREIGN_ROW / MISSING_ROW | — | `retention-plan`의 수용/거절 2케이스 |
| 같은 행 수·다른 내용 (WAL→DELETE, DELETE→WAL) | 행 수만 비교해 통과 | `retention-consistency`: “refuses a candidate copied from a file the selection never read”, 경로 교체 2케이스 |
| 표·열·migration·generation 변조 | — | `retention-plan`: “rejects a candidate whose table set or generation history was altered” |
| 동시 쓰기(notification/recommendation replacement) | 성공 처리 | `retention-consistency`의 4개 interleaving 케이스가 `LOCAL_RETENTION_SOURCE_CHANGED` 또는 snapshot 고정으로 거절 |
| 목적지 별칭 `/./`·기존 파일·경쟁 생성 | 원본 삭제 | `retention-destination` 3케이스 |
| 원본 쓰기 | 유지보수 checkpoint가 원본 main/WAL을 변경 | `retention-source-writes`: main bytes 불변, WAL은 운영 기록 2행만큼만 증가, 데이터 표 변경 0 |
| 급사 복구 | (신규 요구) | `retention-recovery` 6케이스, 실제 자식 프로세스 5개 종료 지점 |

## 4. M1–M6 판정

| 마일스톤 | 판정 | 근거 |
|---|---|---|
| M0 기준 | 완료 | 원장의 M0 표 |
| M1 R2 정책·인코딩 | 완료 | §3 표, `retention-plan` 4케이스 + `retention-consistency` 14케이스 |
| M2 급사 복구·교체 | 완료 | `retention-recovery` 6/6, 5개 강제 종료 지점 |
| M2 일정화 | 완료 | `retention-schedule` 5/5, 용량 4주기 실측 |
| M3 인용 계약 | 완료 | `local-observation-citation-contract` 3/3 |
| M3 actionable 생산 체인 | **잔여** | advisory 로컬 관측만으로는 owner-gated 행동을 만들 수 없음(설계상 정확). 실제 owner decision 표면 또는 verified live adapter 필요 |
| M4.1 provider refresh adapter | 완료(내부) | `second-brain-refresh-receipt.test.ts` 6/6, daily 회귀 5파일/35테스트 |
| M4.1 provider 계약 | **외부 잔여** | receipt 스키마 미합의. 인계 bundle 작성 완료 |
| M4.2 결속·차단 전파 | 완료(내부) | `memory-candidate-task-source.test.ts` 4/4, 인접 memory 회귀 3파일/25테스트 |
| M4.2 rebuild·복원 | 완료(내부) | 같은 파일 6/6: 차단 후보의 결속 동반 제거, 복원 후 재유입 0 |
| M4.2 저장분 철회 | **잔여(내부+외부)** | 이미 저장된 파생 기억의 철회는 소유자 승인 명령과 provider 계약 필요 |
| M5 준비물 | 완료(내부) | 설정 manifest·preflight 실측·업무안·적용/rollback 문서 |
| M5 실제 실행 | **외부 잔여** | 실행자 인증 3개 키 미설정, fail-closed 확인 |
| M6 통합 gate·패키지 | 완료 | §6 |

## 5. 실제 계보와 그 한계

`source → collection → observation → context → recommendation → brief`는 제품 모듈로 성립하고
(`local-observation-recommendation-lineage.test.ts`), 보류·교체·격리·재시작·capped·만료 결과가 회귀로
고정돼 있다. 이번에 바뀐 것은 **증거 종류의 계약**이다.

- 실제 assembler 출력: `["context_observation", "confirmed_memory"]` (실측).
- 추천 행동이 인용하는 종류: `linux_live_fact` / `user_confirmed_principle` / `owner_decision`.
- 새 계약은 각 증거를 **출처에서** 분류한다. 로컬 task-timeline 관측은 `advisory_local_source`로 남고,
  `citationAvailable(..., "linux_live_fact")`와 `..."owner_decision"`은 모두 false다.

따라서 advisory 로컬 체인으로 actionable 추천을 만드는 경로는 **존재하지 않는 것이 정확하다**. 이를
성립시키려면 실제 owner decision 또는 verified live Linux 출처가 필요하며, 계약을 고쳐서 만들 수 없다.
기존 fixture 체인이 brief까지 도달한 것은 fixture가 인용 종류를 직접 써넣었기 때문이고, 이 회신서는 그
fixture 통과를 실제 생산자 통과로 세지 않는다.

## 6. 게이트·패키지 실측

### 6.1 전체 verify

| 항목 | 값 |
|---|---|
| run_id | `verify-20260911T084128Z` |
| command / cwd | `npm run verify` / worktree 절대경로 |
| source_head / tree | `0af10257…` / `b49d39ce…` |
| input_digest_before | `sha256:1187b1c115deb76e6119c745cf11223f9d0ebc4a80f63266f9ee40dcc6fdf338` (작업 트리 파일 내용 기준, `tracked_changes=0`) |
| input_digest_after | 동일 (`input_stable=true`) |
| started / finished | `2026-09-11T08:41:28+00:00` → `2026-09-11T09:06:02+00:00` (24분 34초) |
| exit_code / signal | `0` / `null` |
| result_source | direct-process (이 세션이 monitor로 직접 회수) |
| toolchain | node `v24.19.0`, npm `12.0.2`, abi `137` |
| 집계 | backend shard1 278파일/1,921 · shard2 278파일/1,930 · dashboard 38파일/263 = **594파일 / 4,114 테스트** |
| architecture | 667 모듈 / 2,481 간선 / 순환 0 |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false` |
| log | `<QA>/verify-20260911T084128Z/verify.log`, sha256 `8a4b974d5701aa8747e2866084edbd79f013190ef70883b7ad55c1bfd53dde3b` |

과거 4,066은 목표치로 쓰지 않았다. 위 수치는 그 실행의 로그 실측이다.

> **이 표는 `0af1025` 기준점이며 현재 제품의 검증이 아니다.** 그 뒤로 제품 코드가 바뀌었으므로
> 현재 제출의 gate는 §9.5다. 여기 수치를 새 코드에 소급하지 않는다.

**합격 근거에서 제외한 run이 있다.** `verify-20260911T020553Z`(같은 입력, 같은 HEAD)는 exit 1로
끝났다. 실패는 1건이었다:

```
FAIL tests/integration/dashboard-personal-integrity.test.ts
  > returns the exact stale-cursor error when an HTTP anchor changes
  expected '"code":"PERSONAL_CURSOR_STALE"', received '"code":"PERSONAL_CURSOR_INVALID"'
```

이 실패를 숨기지 않고 다음을 실측했다.

- 같은 파일 단독 실행: **11/11 통과, 2회 연속**.
- 이번 변경이 건드린 dashboard 파일: **0개** (`git diff --name-only 082d689..HEAD | grep -ci dashboard`).
- 같은 입력으로 다시 실행한 `verify-20260911T023025Z`: exit 0.

구조적으로 `PERSONAL_CURSOR_INVALID`는 커서 복호화·세션·epoch 불일치에서 나오고, 커서 세션 키는
`src/dashboard/read-model.ts:58`의 기본 인자로 **read model 생성마다 새로 만들어지는 난수**다. 서버는
`src/dashboard/server.ts:120`에서 한 번만 생성하므로 단일 테스트 안에서는 안정적이며, 타이머 기반
재생성도 없다. 따라서 이 실패는 4,000건 규모 shard 안에서만 재현된 **기존 비결정성**이며, 원인을
확정하지 못한 채로 남긴다. 테스트나 제품을 초록으로 만들기 위해 수정하지 않았다. 후속 항목으로
보고한다: 커서 세션 키를 서버 수명과 명시적으로 결속하고, 이 케이스를 shard 순서와 무관하게
결정적으로 만드는 작업.

### 6.2 최신 런타임 패키지

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-0K85tx` |
| source_head | `0af10257…` (`source_dirty=true` — untracked 3건) |
| payload_files / dependency_entries | 1,529 / 6,668 |
| receipt pin (독립 고정) | `0d38335f004d702d928746014307d90306150503670016010eb3320f3e1f546e` |
| verify-runtime-package | `ok=true`, `integrity=matched`, RC 0 |
| signature_verified | **false** (운영 서명 없음) |
| runtime_validation | `not_performed` |
| deployment_ready | **false** |
| packaged dashboard HTTP | `/` 200(1,733B), 번들 JS 200(452,054B), CSS 200(26,606B), `/api/v1/health` 200. input digest `sha256:8e77b3e8…`, 1,613파일 |

receipt 기대값은 후보 패키지 자신이 아니라 개발 checkout에서 먼저 고정한 뒤 검증기에 전달했다. 패키지
성공은 개발 증거이며 배포 준비 완료가 아니다.

### 6.3 migration 바이트 비교

베이스라인 95개 파일 전부 sha256 **변경 0**, 신규 3개만 추가:
`089_local_retention_operations.sql`, `090_local_retention_cycle_fence.sql`,
`091_memory_candidate_task_sources.sql`.
벡터는 `<QA>/migration-hash-vector.json`.

### 6.4 원본 쓰기와 checkpoint의 물리 영향

apply가 원본에 남기는 쓰기는 **자기 운영 기록 2행(삽입 1 + 판정 갱신 1)뿐**이다. 실측:
`total_changes` = before+2, 데이터 표 행 수 전부 동일, 원본 main 파일 바이트 불변, WAL만 그 2행만큼
증가, shm 존재. checkpoint는 이제 이 호출이 소유한 snapshot에 적용되므로 원본 main을 건드리지 않는다.

## 7. 외부 blocker와 내부 잔여의 구분

### 7.1 M4.1 — Second Brain refresh receipt

**외부(계약 부재).** provider측 refresh receipt 스키마와 endpoint가 아직 합의되지 않았다
(`docs/planning/daily-refresh-publication-contract.md:36-37`). 관련 스키마/프로필 버전 검색 매치 0.

**설치물은 실재한다(실측).** `/home/jm/.local/state/second-brain/app/current` →
`releases/41f0751aca8906d612961e704bc60dd0855fdabd`, `bin/second-brain-mcp`·`bin/sb` 실행 가능,
`~/.config/second-brain/config.toml` 존재.

**JARVIS측은 이번에 끝냈다.** `src/cli-evening-inputs.ts:34-35`의 `refresh_reader: { read: () => null }`
하드코딩과 CLI의 상수 `provider_refresh: "unavailable"`을 함께 제거했다.

- `src/second-brain-refresh-receipt.ts`: 동결한 profile만 수용하는 버전 협상, 심볼릭 링크 거부,
  8,192 byte 상한, bounded strict JSON, 닫힌 envelope. 거절 사유를 `lastOutcome()`에 기록한다
  (`unconfigured` / `unreadable` / `unsupported(profile·envelope)` / `received`).
- receipt payload는 손대지 않고 통과시킨다. `fresh`·`capped`·`stale`·`incompatible`·`invalid` 분류는
  제품의 `evaluateRefreshContext`가 그대로 한다. 어댑터는 성공을 합성하지 않는다.
- `provider_refresh`는 이제 run이 실제로 저장한 `refresh_context` 단계에서 나오며, 그 단계를 원장이
  과금할 때 쓰는 파서(`parseRefreshContextDetail`)를 공유한다.
- receipt 경로는 새 입력이므로 양쪽 daily 설정 모두 **`schema_version: 2`** 로 들어온다. 버전 1
  레코드는 그대로 닫혀 있다.
- 계약 회귀 `tests/integration/second-brain-refresh-receipt.test.ts` 6/6. 이 파일은 상단에
  **CONTRACT TEST**로 표시했고, 여기의 fake receipt를 실제 provider 통과로 세지 않는다.

인계 bundle은 `docs/claude-second-brain-contract-handoff-2026-09-11.md`이며 **전송하지 않았다**.
정확한 envelope·예시 payload·오류/호환 규칙·격리 harness 실행법·도착 후 검증 절차·통과 기준을 담았다.

### 7.2 M4.2 — task 결과 → 기억 후보의 출처·삭제 전파

**두 P1은 검사 두 개가 아니라 결속 하나가 없던 문제였다.** 후보는 자기가 지나온 control command·
verification·session은 이름을 갖지만, 그 작업을 한 **task를 지목한 적이 없었다**. 그래서 소유자가 task를
숨겨도 그 task의 요약은 열람·승인·저장될 수 있었다. 우회로(후보의 `control_request_id` → 
`target_json.$.task_id`)도 검토했지만, 기억 후보가 만드는 control command의 target은
`{candidate_id, correlation_id}`뿐이라 task에 닿지 않는다.

이번에 구현한 것:

- `migrations/091_memory_candidate_task_sources.sql`: 후보 **옆에** 두는 결속표. 후보의 identity·
  source·content digest는 이미 봉인돼 있어, 증명 대상이 아니던 관계를 넣겠다고 그 형태를 바꾸면 저장된
  모든 후보가 무효가 된다. 후보당 task 하나, 접수 때 한 번 기록, update·delete는 표 자신이 거절한다.
- `src/memory-candidate-task-source.ts`: 접수 시 **이미 숨겨진 task면 거절**한다(같은 트랜잭션에서 검사와
  기록). 소비 시에는 다시 묻는다.
- 소비 지점 연결: `readCandidateReview`(검토 열람), `stageMemoryCandidateDecision`(**미리 준비된 승인의
  확정**), `hasMemorySourceAuthority`. 후자는
  `hasSecondBrainWriteAuthority`·`hasRegisteredScopedSourceAuthority`·
  `hasDispatchedScopedSourceAuthority` 세 함수가 공유하는 단일 gate이므로, 쓰기뿐 아니라 **outbox
  preflight·dispatch·scoped 등록·이미 발송된 시도**까지 같은 판정을 받는다. 이 사실은 호출 그래프로
  추정하지 않고 회귀로 단정했다.
- `jarvis memory classify <input.json> <policy.json> [TASK_ID]`: 선택적 다섯 번째 위치 인자로 결속을
  받는다. 인자가 없으면 결속이 없고 기존 동작 그대로다.

회귀 `tests/integration/memory-candidate-task-source.test.ts` 4/4: 숨겨진 task로는 접수 거절(결속 0건),
사후에 숨기면 검토 `undefined` + 쓰기/등록/발송 판정 false, 결속 없는 후보는 영향 없음, 결속은 한 번만
기록되고 UPDATE·DELETE는 트리거가 거절. 인접 memory 회귀 3파일/25테스트 통과.

이번에 추가로 고정한 두 가지:

- **rebuild 동반 제거.** 차단된 후보는 부모 행이 지워지므로 결속이 남으면 FK가 끊기고 rebuild 자체가
  거절된다. 정제기에 규칙을 넣었다가, 복사기가 `candidate_id` 열을 가진 모든 표를 차단 집합으로 이미
  거르고 있음을 **규칙을 빼고 다시 돌려** 확인한 뒤 되돌렸다. 단정만 남겼다.
- **백업 복원 재유입 0.** 백업을 뜬 **뒤에** 숨긴 task는 복원본에서도 숨겨진 채다. 결속은 후보와 함께
  이동하고 차단은 현재 authority와 함께 이동하므로, 복원된 DB의 검토도 `undefined`를 돌려준다.

**남은 것(내부) 둘.**

1. 이미 저장된 파생 기억의 **실제 철회 실행**. 이번에 `memoriesAwaitingTaskWithdrawal`로 “무엇이 남아
   있는지”는 열거한다(보이는 task 0건, 숨기면 candidate·task·content digest 1건, 결속 없는 DB 0건).
   저장분 매칭 기준은 복원 경로와 같은 content identity이고, 같은 식별자로 resolved target metadata에
   닿아 각 항목이 `target_id`/`target_digest`를 함께 싣는다(저장 전이면 null).
   `MemoryDeletionStore.request()`의 입력 벡터는 확인했으나 `scope_digest`·`payload_digest`·spool 값은
   effect V2 계약에서 생성해야 한다. 철회를 기록하는 suppression은 tombstone
   chain에 결속된 소유자 승인 산출물이므로 개발에서 만들지 않았고, 승인 경로와 함께 구현해야 한다.
2. 제외 프로젝트 범위 검사(§8.2.3). 실측하면 후보 정책과 후보 모듈 전체에 `project`/`exclude` 개념이
   **없고**(`grep` 매치 0) config에도 제외 목록이 없다. 비밀 검사와 원본 hold 검사는 있으나 이 항목은
   정책 계약에 범위 필드를 더하는 설계부터 필요하다. 하나 남았다고 쓰지 않기 위해 함께 적는다.
**남은 것(외부).** 직접 MCP 클라이언트 2개에서 삭제된 파생 기억이 반환되지 않는지 확인하는 것은
provider lineage 계약이 필요하다.

### 7.3 M5 — 업무 실행자

**외부(인증 미설정).** 실측 `node dist/src/cli.js routing probe-runtime claude-code`:
`configuration: "missing"`, 없는 키 `JARVIS_TASK_CLAUDE_PATH`·`JARVIS_TASK_VERIFIER_KEY_PATH`·
`JARVIS_TASK_VERIFIER_KEY_ID`, `execution_available: false`, `readiness: "not_probed"`,
인증 `reason_code: "TASK_AUTH_PROBE_NOT_CONFIGURED"`, 측정 `2026-09-11T02:05:43.813Z`.
값은 출력하지 않았다. 로그 `<QA>/executor-readiness.log`.

**내부 준비물은 이번에 끝냈다.** `docs/claude-task-execution-readiness-2026-09-11.md`에 키별 검증 규칙,
대상 업무 1건(기존 `code-fix` 템플릿), 예상 쓰기/외부 효과, 사전 gate, 적용 순서, health/readback,
rollback 조건·명령을 적었다. 새 fixture 키를 만들어 운영 인증으로 대체하지 않았다.

## 8. Codex를 위한 최소 재검증 절차

이미 통과한 전체 gate의 재실행은 요구하지 않는다.

1. checkout 확인
   ```bash
   cd /home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui
   git log --oneline -6
   git rev-parse 0af102572ef9a21f3661967636b5f091eb5c5f13
   git status --porcelain
   git diff --name-only 0af1025..HEAD
   ```
   제품 검증 SHA는 `0af1025`이고, 마지막 명령이 `docs/`만 보여야 제품 입력 무변경이 성립한다.

2. 원래 P1 재현과 정식 회귀
   ```bash
   npm run build:backend
   npm run test:integration -- \
     tests/integration/local-observation-retention-plan.test.ts \
     tests/integration/local-observation-retention-consistency.test.ts \
     tests/integration/local-observation-retention-recovery.test.ts \
     tests/integration/local-observation-retention-schedule.test.ts \
     tests/integration/local-observation-retention-source-writes.test.ts \
     tests/integration/local-observation-citation-contract.test.ts \
     tests/integration/second-brain-refresh-receipt.test.ts \
     tests/integration/memory-candidate-task-source.test.ts
   ```
   기대: 전부 통과. 특히 감사 행 손실·값 충돌·ATTACH ABA·선정 외 삭제가 모두 거절되는지.

3. receipt와 입력 readback
   ```bash
   cat /home/jm/.cache/jarvis-m6-20260911/verify-20260911T084128Z/receipt.env
   sha256sum /home/jm/.cache/jarvis-m6-20260911/verify-20260911T084128Z/verify.log
   ```
   기대: `exit_code=0`, before/after digest 동일, log sha256이 §6.1과 일치.

4. 패키지 검증
   ```bash
   node scripts/verify-runtime-package.mjs \
     /home/jm/.cache/jarvis-m6-20260911/package/jarvis-runtime-0K85tx \
     --receipt-sha256 0d38335f004d702d928746014307d90306150503670016010eb3320f3e1f546e
   ```
   기대: `integrity=matched`, `deployment_ready=false`.

5. 제출물 자체의 상호 일치
   ```bash
   node /home/jm/.cache/jarvis-m6-20260911/check-submission-consistency.mjs
   ```
   회신서의 SHA·digest·집계가 receipt와 manifest, 디스크의 증거와 일치하는지 읽기 전용으로 재검사한다.
   기대: `problems: []`, exit 0. 이 검사에서 실제로 1건(migration 벡터 해시가 091 추가 후 갱신되지 않음)을
   찾아 고쳤다.

6. 결론: R2/M2/M3 인용 계약/M4.1 adapter/M4.2 결속·차단 전파의 인수 여부를 판정하고, 남은 M4.2 두 항목(저장분 철회, 제외 프로젝트 범위)의 진행과 §7.1·7.2·7.3의 외부 의존성 해소(누가 무엇을 제공할지)를 지시한다.

## 8bis. 독립 리뷰 — 수행함, 지적 9건 전부 수정

`independent_review=not_performed`이 아니다. 다른 모델(GPT-5.6)에게 `082d689..HEAD`의 제품 diff 전체를
읽히고, 계약별로 성립 여부와 재현을 요구했다. 판정은 **CHANGES_REQUIRED**였고 P1 7건·P2 1건·P3 1건이
실행 가능한 재현과 함께 제기됐다. 재현 스크립트는
`/home/jm/.cache/jarvis-indep-review-20260911/*.mjs`에 있다.

전부 수정했고, **각각을 리뷰어 자신의 재현으로 전후 대조**했다.

| 지적 | before (리뷰어 실측) | after (같은 스크립트) |
|---|---|---|
| P1 2^53 초과 정수 row key 충돌 | `accepted:true` — INTEGER 열이 달라도 통과 | `accepted:false`, `FOREIGN_ROW at progress_report_outbox` |
| P1 검증 후 후보 변조 후 설치 | `operation:"applied"`, 라이브에 `tampered-after-verification` | `LOCAL_RETENTION_CANDIDATE_MODIFIED`, 라이브는 원본, 상태 `verified` |
| P1 최종 검사 이후 원본 쓰기 유실 | `error:null`, `lateRows:0` | `LOCAL_RETENTION_SOURCE_CHANGED`, `lateRows:1`(보존) |
| P1 snapshot 미소유 삭제·미설명 후보 | `snapshotExists:false`, `candidateExists:true` | `snapshotExists:true`, `candidateExists:false` |
| P1 복구의 경로 기반 TOCTOU·sidecar | 확인 후 경로로 삭제 | 원자적 이동 → 이동한 객체 확인 → 삭제, 아니면 되돌리고 `retained_unproven` |
| P1 숨긴 task 접수가 unbound 후보 커밋 | `rows:[awaiting_confirmation]`, `visible:true` | `rows:[] bindings:[] reviewFiles:[] visible:false` |
| P1 준비된 승인이 receipt 적용에서 통과 | `state:"approved"`, `pubs:[published]` | `MEMORY_CANDIDATE_SUPPRESSED`, 발행 0 |
| P2 복구가 일정 창에 가려짐 | claim 이후 실행 | claim 이전 실행, `deferred`도 `recovered` 보고 |
| P3 routing CLI가 5번째 인자 수용 | 무시되는 인자 허용 | `=== 4` 복구 (내가 낸 계약 파손) |

리뷰어가 성립한다고 판정한 것: refresh receipt 계약(JARVIS 측), 인용 분류, 배포 migration 불변,
버전 1 설정 레코드 폐쇄성, 091의 FK가 rebuild·restore를 견딤.

수정 과정에서 **제가 만든 회귀 두 개를 스스로 잡았다.** 복구가 snapshot sidecar를 남겨 재시도를
영구히 막은 것(디렉터리를 찍어 확인)과, 바이트 기준선을 연결을 닫기 전에 계산해 정상 교체가 항상
거절된 것(fence를 단계별로 찍어 확인)이다. 둘 다 추측을 세 번 빗나간 뒤 측정으로 특정했다.

리뷰 수정으로 운영 기록 모듈이 리뷰가능성 한계를 넘자 gate가 그것을 잡았고(`exit 1`), 아티팩트
수명주기를 `local-observation-retention-artifacts.ts`로 분리해 해소했다. 그 실패 run도 §6.1의 제외
목록과 같은 원칙으로 기록에 남긴다.

## 8quater. 2차 독립 리뷰 — 수정 자체를 다시 읽혔고, 4건이 열려 있다

같은 방식으로 **수정 커밋 범위**(`e53c857~1..HEAD`)를 다른 모델에게 다시 읽혔다. 판정은 또
**CHANGES_REQUIRED**였고 P1 6건·P2 3건이 나왔다. 5건은 제 수정이 만든 것이었다.

닫은 것(각각 리뷰어 재현으로 대조): INTEGER와 REAL이 같은 키를 만들던 문제, generation 비교가 JSON
숫자로 반올림되던 문제, 자동 publication과 legacy correction 승인·준비의 task 차단 누락,
`verified_digest` 가변, `.releasing` 이름 선점, 복구가 살아 있는 소유자의 작업을 파괴하던 문제.

**그중 2건은 이후 닫았다.** 운영 전용 디렉터리를 구현해(`0af1025`) 산출물이 공유 이름 공간을 떠났다.
생성 자체가 확보이고, 그 안에는 이전부터 있던 파일이 존재할 수 없으며, 해제는 디렉터리 하나를 지우는
한 동작이다. 그래서 snapshot 정리가 남의 파일을 지우던 문제와 `.releasing` 이동+삭제 사이의 크래시
고아가 **메커니즘째 사라졌다**. 옆에 놓인 유령 sidecar는 예전엔 SQLite가 그것으로 복구할 수 있어
거절해야 했지만 이제 이웃 파일일 뿐이며, 회귀도 그렇게 바뀌었다(retention 59/59).

**남은 2건은 하나의 설계 문제다.** 교체 구간(후보 digest 확인~rename, 원본 마지막 읽기~rename)에
**프로세스 간 배타성이 없다**는 것, 그리고 운영 행을 쓰기 전에 죽으면 **행이 없는 디렉터리**가 남아
복구가 알지 못한다는 것이다. 리뷰어의 처방도 하나다:
**운영 전용 비공개 디렉터리 + 프로세스 간 swap/rebuild lease**. 바이트 비교로는 닫히지 않는다는
지적은 옳고, 이 변경은 apply의 경로 계약·복구·교체·일정 서비스와 관련 회귀를 함께 바꾼다. 절반만
적용하면 같은 계열의 결함을 남긴 채 겉보기만 달라지므로 **독립된 단위로 설계·구현·재리뷰**하도록
범위를 고정하고 여기서 멈췄다. 이것이 이 회신서가 `IN_PROGRESS`인 이유다.

그 단위는 `docs/planning/retention-operation-directory-design.md`에 실행 가능한 형태로 고정했다:
`freshPath`를 파일이 아닌 **디렉터리**로 해석해 산출물을 그 안에만 두는 변경(남의 파일이 우리 자리에
있을 수 없게 되어 snapshot 정리·sidecar·`.releasing` 계열이 사라진다), 고정 부모 아래 두어 복구가
**행 없는 디렉터리**를 열거·보고하게 하는 변경(운영 행 이전 크래시), 그리고 교체 배타성의 세 가지
선택지(공유 swap lease / runtime 단일 진입점 / 현상 유지와 명시)다. 마지막 항목은 제품 전체 계약을
바꾸므로 **소유자 결정**이 필요하며 이 노트는 선택하지 않는다. 건드릴 파일 10개와 다시 쓸 회귀,
완료 판정(네 재현이 뒤집히고 3차 독립 리뷰가 깨끗할 것)까지 같은 문서에 적었다.

## 8ter. 남은 항목별 blocker, 준비물, 재개 조건

각 항목에 소유자·필요한 입력·이미 준비한 파일·재개 명령·통과 기준을 붙인다.

| 항목 | 소유자 | 필요한 입력 | 준비된 파일 | 재개 후 통과 기준 |
|---|---|---|---|---|
| M4.1 provider refresh receipt | Second Brain provider | 인계 문서 §3.2 envelope를 발행하는 release | `docs/claude-second-brain-contract-handoff-2026-09-11.md` (미전송), 계약 회귀 `second-brain-refresh-receipt.test.ts` | 설정 `schema_version: 2`에 경로를 넣고 `jarvis daily morning --once` → `provider_refresh: "fresh"`, 저장된 `refresh_context`가 같은 `refresh_id` |
| M4.2 저장분 철회 | Second Brain provider | 기록의 현재 위치를 되짚는 **재해석 계약** (`vault_head`/`vault_tree`/`page_id`/`page_blob_oid`/citation span/유효 구간) | 필드 대조표와 정지 지점(`docs/planning/task-memory-source-privacy-hold.md` 말미), 대상 열거 `memoriesAwaitingTaskWithdrawal` | 재해석 응답을 `ResolvedMemoryTargetV2`로 옮겨 `MemoryDeletionSaga.prepare()`가 소유자 승인 명령을 반환, 승인 후 목록이 비워짐 |
| M4.2 2클라이언트 확인 | Second Brain provider | `source_lineage`/`task_lineage`/`completion_id` 필드 | 같은 문서의 P1 인용과 재개 조건 | 직접 MCP 클라이언트 2개에서 삭제된 파생 기억 0건 |
| M4.2 제외 프로젝트 범위 | 소유자 / Codex | **프로젝트 정체성을 어디에 둘지 결정** (task `scope_json` 파생 / 정책 v2 `excluded_projects` / 결속표 project 열) | 네 층위 부재 근거와 선택지 3개의 파급(같은 문서) | 결정된 위치에 범위 필드를 넣고 접수·소비 양쪽 검사 회귀 통과 |
| M5 실제 업무 실행 | 운영자 | service 환경의 키 3개 | `docs/claude-task-execution-readiness-2026-09-11.md` (검증 규칙·업무안·적용/rollback) | `routing probe-runtime claude-code` → `execution_available: true`, 승인→실행→서명 검증→완료 receipt |
| M3 actionable 생산 체인 | 소유자 / 실제 live adapter | owner decision 또는 verified live Linux 출처 | 인용 계약과 그 한계(`personal-context-citation-contract.ts`, 회귀 3건) | 해당 출처가 생기면 advisory가 아닌 인용 슬롯이 채워져 brief가 기권하지 않음 |

이 표의 어느 항목도 “구현하면 되는데 안 한 것”이 아니다. 각각 외부 계약, 외부 인증, 또는 제품 결정이
선행되어야 하며 그 근거는 코드/스키마 수준에서 확인해 문서에 남겼다.

### receipt harness 결함을 스스로 고쳤다

이 회신서의 모든 gate receipt는 실행 전후 입력 digest를 비교한다. 그 digest를 `git ls-files -s`로
계산하고 있었는데, 그것은 **인덱스**를 해시한다. 커밋 전에 게이트를 돌린 run 하나에서 작업 트리의
변경이 digest에 잡히지 않아 "테스트한 것"과 "receipt가 말하는 것"이 어긋났다. 그 run은 채택하지 않고,
harness가 작업 트리 파일 내용을 해시하도록 고친 뒤(`tracked_changes` 수치도 함께 기록) 커밋된 상태로
다시 돌린 결과가 §6.1이다. 이전 run들은 트리가 깨끗한 상태에서 돌렸으므로 값 자체는 정확했다.

## 9. 수행하지 않은 행동

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제를 하지 않았다.
운영 서명·notarization·실제 업무 실행·provider 쓰기·외부 전송도 하지 않았다. 독립 리뷰는 §8bis대로 **수행했고** 지적 9건을 전부 수정했다. 다만 그 리뷰어는 이 구현을 쓰지 않은
다른 모델일 뿐 운영 승인 권한이 없으므로, 그 APPROVE를 최종 인수로 쓰지 않는다. 이 회신서는 Codex의
독립 검증을 그대로 요청한다.


## 9. 복구 라운드 CODEX-JARVIS-RECOVERY-20260911-02 (2026-09-11)

이전 세션은 코드가 완료되어 끝난 것이 아니라 대화 컨텍스트 한도로 멈췄다. 제품 트리는 그대로
보존됐고, 이 라운드는 그 지점에서 이어졌다. 시작 실측은 HEAD `49783df`, tracked M 5 / D 0,
untracked에 `migrations/095`·`migrations/096`·followup 문서였다.

### 9.1 인계된 실패 4건의 실제 원인

baseline(`qa/retention-baseline.log`) 7파일 62테스트 중 4 failed. 세 건과 한 건의 성격이 다르다.

| 실패 | 관측 | 성격 | 처리 |
|---|---|---|---|
| `retention.test` "applies the selector…" | expected 143 to be 140 | **계약 변화**. 확보 대장이 도입되면서 apply가 source에 쓰는 행이 2에서 5로 늘었다(intent → identity → operation → intent 소멸 → verdict) | 단정을 +5로 갱신하고 `local_retention_claim_intents` 잔여 0을 함께 단정 |
| `retention.test` "does not remove a group…" | expected 144 to be 141 | 같음 | 같음 |
| `retention-source-writes` "leaves the source untouched…" | expected 144 to be 141 | 같음 | 같음 |
| `retention-schedule` "holds the window…" | expected 'failed' to be 'processed' | **제품 결함** | 아래 |

제품 결함은 다음과 같다. `memory-authority-fresh-builder`는 `sqlite_master`의 모든 표를
조건 없이 복사하므로 `local_retention_claim_intents`도 candidate에 실린다. 그 표의 `directory`는
UNIQUE이고, 교체가 끝나면 그 candidate가 live authority가 된다. 결과적으로 새 authority는 **이미 끝난
실행의 죽은 claim**을 상속하고, 그 프로세스는 존재하지 않으므로 정리되지도 않으며, 다음 주기가 같은
디렉터리를 확보하려 하면 UNIQUE 충돌로 `LOCAL_RETENTION_DESTINATION_INVALID`가 난다. 즉 일정화된
보존은 **첫 회차 이후 영구히 실패**한다. `copyFilter`에 규칙을 추가해 닫았다. 처음에는 이 표를 통째로 제외했으나(`WHERE 0`), 독립
리뷰가 "운영 행이 기록되지 않은 남의 intent는 그 디렉터리에 대해 복구가 가진 유일한 행"임을 지적해
**자기 것만 제외**하도록 바꿨다(§9.4). 최종 규칙은 복사 계획에 실린 projection으로 자기 operation의
intent만 배제한다. 복사 계획을 그대로 재사용하는
`assertCandidateMatchesCopyPlan`이 같은 규칙을 보기 때문에 복사기와 검증기가 어긋나지 않는다.

### 9.2 교체 구간 배타성 — followup §4와 M2 §6.1-4의 마감

2차 독립 리뷰가 남긴 4건은 "산출물이 공유 이름 공간에 있고 교체 구간에 프로세스 간 배타성이 없다"는
하나의 뿌리에서 나왔다. 비공개 디렉터리 쪽은 이전 라운드가 처리했고, 이번에 **swap lease**를 닫았다.

두 번째 authority/swap 체계를 만들지 않았다. 이미 있던 세 가지를 결합했다.

- 모든 연결이 지나는 단일 open 경계: `AuthorityDbBase` 생성자와 `reopen()`.
- `/proc` 기반 open-inode 관측: `discoverOpenInodeHolders`.
- 프로세스 레지스트리: `AuthorityProcessRegistry`.

**배리어.** `<database>.swap-barrier`. 데이터베이스 경로만으로 유도되므로, 배제당할 프로세스가
레지스트리 위치를 알 필요가 없다. pid와 start token을 담아 pid 재사용을 구분하고, 소유자가 사라진
레코드는 살아 있는 배제가 아니라 급사의 잔해이므로 제거된다. 따라서 교체 중 급사가 데이터베이스를
영구히 잠그지 않는다. SQLite가 소유한 `-wal`/`-shm`/`-journal` 접미사와 충돌하지 않는다.

**입장 통제.** 교체 중에는 새 연결이 `AUTHORITY_DATABASE_SWAP_IN_PROGRESS`로 거절된다. 배리어
소유자 자신은 허용되는데, 자기 교체의 마지막 단계가 그 파일을 다시 여는 것이기 때문이다.

**순서가 핵심이다.**

1. checkpoint 후 source fence 확인
2. **배리어 공개 — 아직 연결은 열려 있다**
3. 1차 스캔: 자기 pid를 제외한 holder가 있으면 `LOCAL_RETENTION_SOURCE_WRITER_ACTIVE`로 거절
4. close
5. 2차 스캔: 이제 자기 것까지 포함해 `fd_count`가 0이어야 한다. **여기까지 아무것도 지우지 않는다**
6. sidecar 제거 → byte 기준선 → applied 기록 → byte 재확인 → rename → reopen → 배리어 해제

공개가 스캔보다 먼저이므로, 스캔 이전에 열린 연결은 스캔이 보고 스캔 이후의 연결은 입장 통제가
막는다. 이것이 "마지막 검사 직후 다른 프로세스가 커밋"하는 창을 닫는 부분이며, 바이트 비교는 그
대체물이 아니라 그 다음 확인으로 남아 있다.

1차 스캔이 **연결을 닫기 전에** 답하는 것은 편의가 아니다. `RetentionSourceFence.total_changes`는
연결 단위 카운터(`SELECT total_changes()`)라서 `close()`/`reopen()`이 0으로 재시작시키고,
그러면 호출자가 들고 있던 fence가 이후 영구히 "source가 움직였다"로 판정된다. 첫 구현은 close 뒤에
스캔을 두어 실제로 이 결함을 냈고, 격리 회귀의 재시도 단계가 `LOCAL_RETENTION_SOURCE_CHANGED`로
실패했다. 계측으로 `total_changes 143 → 0`을 확인한 뒤 순서를 바로잡았다. 지금은 거절이 아무것도
닫지 않고 쓰지 않으므로, 다른 writer가 사라진 뒤 **같은 candidate로 재시도가 성립**한다.

**공통 프로토콜이다.** compaction 교체(`memory-authority-swap.ts`)도 같은 배리어를 공개·해제한다.
retention끼리만 지키는 lock이 아니다. 다만 compaction의 기존 계약 — 퇴역 inode를 쥔 reader를 rename
이후에 배수하고 `MEMORY_OLD_DATABASE_FD_ACTIVE` 후 `recover`로 완료하는 것 — 은 의도적으로
바꾸지 않았다. 그것은 writer 배제가 아니라 reader 배수이고 기존 인수 회귀가 그 동작을 고정한다.

**협조하지 않는 writer.** `src/`에서 authority 파일을 `AuthorityDbBase` 없이 여는 경로를
열거했다. 실제로 authority 경로를 여는 것은 `cli-runtime-identity.ts`의 진단용 readonly open
하나였고, 같은 admission을 거치도록 했다. 그 함수는 원래 열기 실패를 "unavailable 증거"로 처리하므로
교체 중에는 자연스럽게 unavailable로 보고된다. 나머지 raw open은 rehearsal/stress 경로의 자체 DB이거나
(`local-observation-retention-operation.ts`) candidate 파일이라 source가 아니다. 등록하지 않은
외부 writer는 배제할 수 없으므로 **파괴적 교체 전에 거절**한다 — 이것이 followup §4의 요구다.

### 9.3 격리 회귀와 그 회귀가 실제로 무엇을 고정하는지

`tests/integration/local-observation-retention-exclusivity.test.ts`(작성 시점 3건, 이후 리뷰 대응으로
5건). 모두 **실제 별도 프로세스**를
쓰고, 동기화는 자식의 stdout 라인과 exit 이벤트로만 한다. sleep이 없다.

1. 별도 프로세스가 실제 연결을 쥔 채 교체 시도 → 거절. source inode·행 수·candidate·배리어 파일이
   모두 보존됨을 단정. 자식이 연결을 놓은 뒤 **같은 application으로 교체가 성공**하고 관측 1건이 준다.
   자식은 candidate 빌드 **이전에** 합류시킨다. 빌드 이후에 커밋하는 프로세스는 source fence가 이미
   거절하므로, 그 경우를 배제해야 "열린 디스크립터" 자체가 유일한 거절 사유가 된다.
2. 배리어 유지 중 새 프로세스의 open → `AUTHORITY_DATABASE_SWAP_IN_PROGRESS`, 해제 후 open 성공.
3. 배리어를 쥔 프로세스를 SIGKILL → 다음 open이 허용되고 잔해가 제거된다.

변이 검사(실측): 두 스캔을 `if (false)`로 바꾸면 1번이 실패한다.

    → expected LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE to match LOCAL_RETENTION_SOURCE_WRITER_ACTIVE

즉 수정이 없으면 rename이 그대로 일어나고 **원본을 잃은 뒤** old-fd를 발견해 오류를 낸다. followup §4가
인수 불가로 지목한 바로 그 동작이며, 이 회귀는 둘을 구분한다. 검사 후 원본 코드를 복원했다.


### 9.4 독립 리뷰 — 수행함, 판정 CHANGES_REQUIRED, 전부 수정

§9.2의 첫 구현(`4518103`)을 다른 모델(GPT-5.6, 읽기 전용, 제품 수정·gate 실행 금지)에게 그대로
읽혔다. 입력은 `49783df..4518103` diff와 followup §4·지시서 §6. 판정은 **CHANGES_REQUIRED**,
P1 5건·P2 3건이었고, 지적은 대부분 정확했다. 수정 커밋은 `320b59c`다.

| 지적 | 판정 | 처리 |
|---|---|---|
| 입장 통제가 check-then-open이라 검사 통과 후 스캔 이후에 디스크립터가 생길 수 있다 | **타당** | open을 감싸는 `openUnderSwapAdmission()`이 **디스크립터 생성 전후로 두 번** 묻는다. 늦게 연 쪽은 배리어를 보고 디스크립터를 반납하고, 먼저 연 쪽은 스캔에 잡혀 교체가 거절된다. 두 순서 모두 안전한 결과로 닫힌다 |
| 배리어 획득이 read-then-write라 두 교체가 동시에 "내가 쥐었다"고 믿을 수 있다 | **타당** | 고유 이름에 내용을 먼저 쓰고 `link()`로 이름을 만든다. 승자는 커널이 정하고, 이름이 생기는 순간 내용은 이미 완전하다(반쯤 쓰인 배리어가 관측되지 않는다) |
| 1차 스캔이 같은 pid를 통째로 면제해, 같은 프로세스의 두 번째 연결이 살아 있는데 WAL/SHM을 먼저 지운다 | **타당. 실제 데이터 손실 경로** | 2차 스캔을 **sidecar 제거 이전으로** 옮겼다. 배제가 증명되기 전에는 아무것도 지우지 않는다 |
| compaction이 rename **후에야** 외부 holder를 보고한다 | **타당** | 외부 **writer**는 close·rename 이전에 `MEMORY_SOURCE_WRITER_ACTIVE`로 거절한다. reader/writer는 디스크립터 자신의 `/proc/<pid>/fdinfo` 접근 모드로 구분하고, 읽을 수 없으면 writer로 센다(fail-closed). 읽기 전용 holder를 rename 후 배수하는 기존 계약과 그 인수 회귀는 그대로다 |
| `WHERE 0`이 도달 가능한 복구 증거를 없앤다 | **타당** | 운영 행이 기록되지 않은 intent는 그 디렉터리에 대해 복구가 가진 유일한 행이다. 이제 **자기 것만** 제외한다. 제외 대상은 복사 계획에 실려 복사기와 검증기가 같은 규칙을 본다 |
| 배리어 경로가 철자에 의존한다 | 타당 | 배리어 이름과 기록되는 `database`를 부모의 realpath 기준으로 정규화했다 |
| 정리 경로가 예외 안전하지 않다 | 타당 | 실패 경로에서 reopen과 해제를 각각 감싸 **원래 오류를 덮지 않는다**. 연결은 열린 채로, 배리어는 해제된 채로 빠져나간다 |
| 회귀가 두 경주를 노출하지 못하고 exit 리스너를 늦게 단다 | 타당 | exit 프라미스를 spawn 직후에 등록했다(빨리 끝난 자식이 타임아웃까지 매달리던 실제 결함). 경주 두 건을 추가했다 |

추가 회귀 3건(합계 **9 files / 69 tests**):

1. 열리는 도중 교체가 시작되면 **연결을 반납한다** — 살아 있는 별도 프로세스를 소유자로 하는 배리어가
   open 콜백 안에서 등장하고, 열린 디스크립터가 닫혔음을 단정한다.
2. 두 프로세스가 배리어를 동시에 노리면 **정확히 하나만 성공한다**.
3. 다른 실행의 claim intent가 candidate로 **이월된다**(자기 것은 소멸).

변이 검사(실측): 사후 재확인을 제거하면 1번만 실패한다
(`failed=["gives a connection up when a swap begins while it is being opened"]`).
`link()` 획득을 비배타적 쓰기로 바꾸면 4건이 실패한다. 두 번째 변이는 넓게 실패하므로 원자성만
분리해 증명하지는 않는다 — **원자성 자체는 `link()`의 커널 보장이고, 회귀가 고정하는 것은
"둘 다 성공하지 않는다"는 불변식**이다. 서브밀리초 인터리빙을 강제하지는 못한다고 명시한다.

남은 한계(정직하게): 등록하지 않고 배리어도 보지 않는 완전 비협조 writer가 마지막 스캔과 rename
사이에 파일을 열면 막을 수단이 없다. 그래서 계약이 "배제할 수 없으면 파괴적 교체 전에 거절"이고,
협조 경로는 위 두 순서로 닫혀 있다. 이 지점은 리뷰어도 커널 강제 lock 없이는 불가능하다고 적었다.


### 9.5 전체 gate 2회차 (배타성 마감 시점)

| 항목 | 값 |
|---|---|
| command / cwd | `npm run verify` / `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| 입력 SHA | `5a53e107e411b645ab3277636a0a0be67ce490e3` |
| 입력 트리 상태 | tracked M 0 / D 0 (docs는 gate 이후 갱신, `src/`·`tests/` 불변) |
| exit code | **0** (`VERIFY2=0`) |
| 종료 시각 | `2026-09-11 23:05:17 +0900` |
| toolchain | node `v24.19.0`, npm `12.0.2` |
| backend shard 1/2 | **279 파일 / 1,929 테스트 통과**, 778.33s |
| backend shard 2/2 | **278 파일 / 1,931 테스트 통과**, 680.07s |
| dashboard | **38 파일 / 263 테스트 통과**, 37.08s |
| 합계 | **595 파일 / 4,123 테스트** |
| architecture | `{"ok":true,"scope":"static_internal_esm","modules":668,"edges":2490,"cycles":[]}` |
| acceptance | `{"boundary":"pre_gjc_ready","aggregate_status":"stopped","completion_promoted":true,"gjc_dispatched":false}` |
| 로그 | `<QA>/verify2.log`, sha256 `1a86b0efead9acc85883953213416a71cb0a69c36d3384ee9e373bf5ddb5f02e` |

**합격 근거에서 제외한 run 2건.** 둘 다 이번 라운드의 내 변경이 원인이거나 내가 중단한 것이며,
숨기지 않고 원인과 처리를 적는다.

1. 입력 `320b59c`, `VERIFY=1`. backend shard 1/2에서 2건 실패
   (`Test Files 2 failed | 277 passed`, `Tests 2 failed | 1927 passed`), shard 2/2는 전부 통과.
   - `task12-runtime-reviewability`: `memory-authority-fresh-builder.ts`가 모듈당 250줄 예산을
     1줄 초과(251). 주석 포함 비어있지 않은 줄을 세는 규칙이다. 주석을 줄여 **248**로 맞췄다.
   - `memory-cancellation-compaction`: 그 테스트는 `observeOldInode`를 `mockImplementationOnce`로
     한 번만 throw시켜 rename 직후 크래시를 재현한다. 내가 넣은 compaction 사전 writer 스캔이 그 1회용
     mock을 먼저 소비해 교체 자체가 일어나지 않았다. 사전 스캔을 `discoverOpenInodeHolders` 직접
     호출로 분리해, 사전 거절과 사후 배수가 서로 다른 호출로 남게 했다. **기대값을 고치지 않았다.**
   - 두 수정은 `5a53e10`이고, 해당 파일 단독 재실행에서 각각 2/2와 11/11 통과를 확인한 뒤 위 gate를
     다시 돌렸다.
2. 그 이전 run은 `VERIFY=143`(SIGTERM). 독립 리뷰 지적을 수정하기로 결정해 **내가 중단**했다.
   입력이 바뀌므로 어떤 근거로도 쓰지 않는다.

### 9.6 migration 바이트 비교 (갱신)

베이스라인 `082d689` 대비 기존 파일 **수정 0**(`git diff --name-status 082d689 HEAD -- migrations`의
`M` 0건), 신규 8개: 089·090·091·092·093·094·095·096. 총 파일 수 **103**.


### 9.7 런타임 패키지 2회차 (배타성 마감 시점)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-E1mFHx` |
| source_head | `5a53e107e411b645ab3277636a0a0be67ce490e3` — gate 입력과 **같은 SHA** |
| source_dirty | `true`. 패키지 시점의 tracked 수정은 `docs/` 2개(이 회신서와 원장)뿐이고 `src/`·`tests/`는 0이다. 나머지는 `node_modules`·`.omo/**` 도구 상태 |
| payload_files / dependency_entries | 1,535 / 6,668 |
| receipt pin (독립 고정) | `39238a3c294f9cb5f158ba53be7e2de896347956d5be671b715b16b9944538d6` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified | **false** (운영 서명 없음) |
| runtime_validation | `not_performed` |
| deployment_ready | **false** |
| 로그 | `<QA>/package.log`, `<QA>/package-verify.log` |

receipt 기대값은 후보 패키지 자신이 아니라 개발 checkout에서 `sha256sum`으로 먼저 고정한 뒤
검증기에 전달했다. 패키지 성공은 개발 증거이며 배포 준비 완료가 아니다. 운영 적용·서명·서비스
전환은 하지 않았고 이 제출의 범위도 아니다.


### 9.8 M4.2 project-scope — 개발 가능한 부분을 전부 구현했다

원장은 이 항목을 "소유자 결정 필요"로 두고 있었다. 실제로 소유자만 정할 수 있는 것은 **목록 그
자체**이고, 그 주변은 전부 개발 가능했다. 커밋 `e2ed929` → 독립 리뷰 → `f1e6b14`로 마감했다.

- **프로젝트 정체성을 지어내지 않았다.** `work_items.snapshot_id → census_snapshots.project_id`는
  control plane이 이미 받아들인 제안의 정체성이다. `config/portfolio-repositories.json`의 GitHub
  slug와 `projects.id`를 잇는 매핑은 존재하지 않으며, 만들지 않았다 — 그것이 followup §5.4가
  금지한 임의 project authority 생성이다.
- **정책 문서는 authority DB 옆**(`<db dir>/memory-project-scope.json`)에 둔다. 닫힌 레코드
  `{schema_version:1, mode:"allow_list", projects:[...]}`이며 파일이 없으면 정책이 없다. 배선이
  필요 없으므로 "문서를 썼는데 아무도 읽지 않는" 상태가 구조적으로 불가능하다.
- **집행 지점은 `bindCandidateTaskSource` 하나**다. 접수(`classify`)든 사후
  기록(`recordCandidateTaskSource`)이든 모든 결속이 이 함수를 지난다.
- **소비도 다시 묻는다.** `candidateTaskSourceClosed()`가 후보를 소비하는 **모든 지점**에서
  "이 후보의 task가 우리에게 닫혀 있는가"를 묻는다: 리뷰, 표면 권한, provider 쓰기, 자동 publication,
  결정 staging, correction saga, correction 확인. 처음에는 3곳만 바꿨고 3차 독립 리뷰가 나머지 4곳을
  찾아냈다(§9.12). 이제 회귀가 "`src/` 어떤 모듈도 suppression만 묻지 않는다"는 불변식을 고정한다. 숨겨졌거나 범위 밖이면 닫힌다. 정책 문서를
  정확히 읽을 수 없으면 **닫는 쪽**으로 판정한다.
- **fail-closed.** 문서가 있는데 프로젝트를 증명할 수 없는 task는 거절한다. alias는 work item에 도달할
  수 있는 유일한 경로인 `continuation_acceptances.work_id`만 따라간다.
- **문서 읽기**는 `O_NOFOLLOW`로 열고 `fstat`로 정규파일·크기를 확인한 뒤 그 디스크립터에서
  읽는다. symlink와 stat↔read 사이 교체가 정책을 결정하지 못한다.

회귀 8건: 허용 / continuation alias 해상 / 목록 밖 거절 / 증명 불가 거절 / **후보 생성 뒤 결속 거절** /
**admission 이후에 쓰인 정책이 소비를 닫음** / 무설정 무영향 / 잘못된 문서 6종 + symlink. 거절 시
DB 행이 없을 뿐 아니라 **review spool에 사적 텍스트가 남지 않음**도 단정한다. 인접 회귀 70파일 632테스트.

소유자 입력으로 남긴 것은 둘뿐이다: (1) `projects.id` 공간의 실제 허용 목록, (2) task가 없는
후보에도 정책을 적용할지(현재는 적용하지 않음 — 그런 후보는 프로젝트를 지목하지 않는다). 둘 다
결정되면 각각 파일 한 개와 한 줄이다.

정직한 한계: JSON 중복 키는 last-wins(JSON 자체 의미)를 따른다. 감사 시 눈에 보이는 값과 파서가 쓴
값이 다를 수 있으며, 이 문서가 소유자 소유 디렉터리에 있다는 전제로 수용했다.

### 9.9 두 번째 독립 리뷰 — 수행함, 판정 CHANGES_REQUIRED, 전부 수정

`e2ed929`을 같은 조건(다른 모델, 읽기 전용, gate 실행 중이라 빌드/테스트 금지)으로 검토시켰다.
P1 3건·P2 3건이며 **가장 중요한 지적은 "정책을 아무도 읽지 않는다"**였다 — 유일한 생산 접수 경로가
`attachProjectScope`를 호출하지 않았다. 그 상태에서 내 커밋 메시지는 사실이 아니었고, 지적이
맞다. §9.8의 설계는 그 지적을 반영해 다시 만든 것이다(경로 규약 + 단일 집행 지점 + 소비 재확인 +
alias + `O_NOFOLLOW`). 나머지 P2(회귀 범위)도 같은 커밋에서 닫았다.


### 9.10 전체 gate 4회차 (project-scope 1차 시점)

project-scope까지 포함한 최종 입력으로 다시 실행했다. §9.5는 그 이전 시점의 기록이다.

| 항목 | 값 |
|---|---|
| command / cwd | `npm run verify` / worktree |
| 입력 SHA | `f1e6b140cacc865aa6cbd5d45b0a4742d09a3234` |
| 입력 트리 | tracked M 0 / D 0 (문서는 gate 이후 갱신, `src/`·`tests/`·`config/` 불변) |
| exit code | **0** (`VERIFY4=0`) |
| backend shard 1/2 | **279 파일 / 1,929 테스트**, 758.72s |
| backend shard 2/2 | **279 파일 / 1,939 테스트**, 675.14s |
| dashboard | **38 파일 / 263 테스트**, 35.93s |
| 합계 | **596 파일 / 4,131 테스트** |
| architecture | `{"ok":true,"modules":669,"edges":2492,"cycles":[]}` |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `gjc_dispatched=false` |
| 로그 | `<QA>/verify4.log`, sha256 `43e80030e7f1368cde09a0d19db6268cf5690d4ff0d701700dbd10f7e43be166` |

이 라운드의 gate 실행 이력은 §9.13에 모았다.

| 회차 | 입력 | RC | 처리 |
|---|---|---|---|
| 1 | `320b59c` | 1 | 내 변경이 만든 실패 2건. `5a53e10`에서 수정 |
| 2 | `5a53e10` | 0 | 배타성 마감 시점의 합격 (§9.5) |
| 3 | `e2ed929` | 143 | 독립 리뷰가 project-scope 재설계를 요구해 **내가 중단**. 근거 아님 |
| 4 | `f1e6b14` | **0** | **이 제출의 정본** |


### 9.11 런타임 패키지 3회차 (project-scope 1차 시점)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-O25Nzv` |
| source_head | `b6403f73f33c1af6bc4e786a8de780485d663a1c` — 제품 SHA `f1e6b14` + 문서 커밋 |
| source_dirty | `true`. tracked 수정 0이며 `node_modules`·`.omo/**` 도구 상태 때문이다 |
| payload_files / dependency_entries | 1,538 / 6,668 |
| receipt pin (독립 고정) | `312fc573f8dda03fb39d14509f34f9b6d52c70d055202735d8d6e8a8873b41ed` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified / runtime_validation / deployment_ready | `false` / `not_performed` / **false** |
| 로그 | `<QA>/package2.log`, `<QA>/package2-verify.log` |

§9.7은 배타성만 마감한 시점의 패키지이고, 이 표가 최종 제출 대상이다. 운영 적용·서명·서비스 전환은
수행하지 않았다.


### 9.12 세 번째 독립 리뷰 — 라운드 전체, 판정 CHANGES_REQUIRED, 수정 완료

범위 `49783df..227d2c9`. 이번에는 코드뿐 아니라 **이 회신서의 주장 자체**를 표본 감사하도록 요청했다.
그 결정이 옳았다. 리뷰는 P1 3건과 함께 **내 보고서의 사실 오류 6건**을 찾아냈다.

| 지적 | 판정 | 처리 |
|---|---|---|
| 잔해 배리어 제거가 TOCTOU: inode 번호가 재사용되면 살아 있는 남의 배리어를 지우고 둘 다 쥘 수 있다 | **타당** | 제거 판정을 dev/ino에 더해 **레코드 바이트 일치**로 바꿨다. 레코드는 pid·start token·기록 시각을 담으므로 다른 발행자의 레코드와 절대 같을 수 없다 |
| 소비 4지점(자동 publication, 결정 staging, correction saga, correction 확인)이 여전히 suppression만 검사 | **타당. 내가 grep 출력을 잘라 보고 완전하다고 단정한 실수** | 전부 `candidateTaskSourceClosed`로 교체하고, 구조 불변식 회귀를 추가했다 |
| compaction이 같은 pid의 두 번째 쓰기 연결을 면제해, 연결을 닫은 뒤 rename이 그것을 고아로 만든다 | **타당** | close 이후 **자기 것도 면제하지 않는** 2차 writer 스캔을 sidecar 제거 **이전에** 넣었다. reader 배수 계약은 그대로다 |
| §0 "남은 개발 작업 없음" | **당시 기준 틀림** | 위 P1을 수정한 뒤에만 성립한다. 수정과 gate 재실행 후 상태를 다시 적는다 |
| §1 "dashboard 파일 변경 0" | **틀림** | 백엔드 dashboard 경로 2개가 바뀌었다. 표를 정정했다 |
| §1 `4518103..HEAD` 문서만 | **틀림** | 그 뒤로 소스·테스트·설정이 더 들어왔다. 확인 명령을 "제품 SHA 이후"로 정정했다 |
| §9.1 `WHERE 0` 서술 | **낡음** | 최종 규칙은 자기 intent만 제외다. 정정했다 |
| §9.3 "3건" | **틀림** | 5건이다. 정정했다 |
| §9.8 "소비 3지점" | **과장** | 모든 소비 지점으로 바꾸고 불변식 회귀를 추가했다 |

리뷰가 P2로 제기한 것 중 **고치지 않고 남긴 것 하나**를 분명히 적는다. claim 디렉터리를 만든 직후
identity를 기록하기 전에 프로세스가 죽으면, 증명할 수 없는 디렉터리와 intent가 남아 그 경로의 이후
주기가 계속 거절된다. 이것은 결함이라기보다 이전 라운드가 의도적으로 택한 **fail-safe**(미입증 객체는
지우지 않는다)의 비용이다. 리뷰가 제안한 해법 — 고유한 staged 이름으로 만들고 identity를 기록한 뒤
목적지로 rename — 은 그 창을 없애므로 타당하며, claim·복구 프로토콜과 그 회귀를 함께 바꾸는 별도
단위로 남긴다. 그 작업을 하지 않은 채로 "교체가 안전하다"고 말하지 않는다.


### 9.13 전체 gate 5회차 (staged claim 이전)

3차 독립 리뷰의 P1 3건을 수정한 입력으로 다시 실행했다. **이 표가 제출의 gate 근거다.**

| 항목 | 값 |
|---|---|
| command | `npm run verify` |
| 입력 SHA | `ca28dfeae593c5d64958a3dcb546643c385c41cf` |
| exit code | **0** (`VERIFY5=0`) |
| 종료 시각 | `2026-09-12 00:26:04 +0900` |
| backend shard 1/2 | 279 파일 / 1,929 테스트, 781.18s |
| backend shard 2/2 | 279 파일 / 1,941 테스트, 688.43s |
| dashboard | 38 파일 / 263 테스트, 36.70s |
| 합계 | **596 파일 / 4,133 테스트** |
| architecture | `{"ok":true,"scope":"static_internal_esm","modules":670,"edges":2494,"cycles":[]}` |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `gjc_dispatched=false` |
| 로그 | `<QA>/verify5.log`, sha256 `392cdae28ed3c1508ef3cbad225711b61aa8a929cfc0b76867d88c22bcdf2595` |

전체 gate 실행 이력 (숨기지 않는다):

| 회차 | 입력 | RC | 처리 |
|---|---|---|---|
| 1 | `320b59c` | 1 | 내 변경이 만든 실패 2건 → `5a53e10`에서 수정 |
| 2 | `5a53e10` | 0 | 배타성 마감 시점 합격. 이후 코드가 바뀌어 근거로 쓰지 않음 |
| 3 | `e2ed929` | 143 | 2차 리뷰가 project-scope 재설계를 요구해 내가 중단 |
| 4 | `f1e6b14` | 0 | project-scope 합격. 3차 리뷰의 P1 수정 전이라 근거로 쓰지 않음 |
| 5 | `ca28dfe` | **0** | **정본** |


### 9.14 런타임 패키지 5회차 (staged claim 이전)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-eRhLO4` |
| source_head | `ca28dfeae593c5d64958a3dcb546643c385c41cf` — gate 입력과 **같은 SHA** |
| source_dirty | `true`. 패키지 시점 tracked 수정은 `docs/`뿐이며 `src/`·`tests/`·`config/`는 0이다 |
| payload_files / dependency_entries | 1,539 / 6,668 |
| receipt pin (독립 고정) | `795044c6332485bbc127b47efbf4ae80daa292f2845f9fd6426d6c779fdb8e74` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified / runtime_validation / deployment_ready | `false` / `not_performed` / **false** |
| 로그 | `<QA>/package3.log`, `<QA>/package3-verify.log` |


### 9.15 3차 리뷰가 남긴 P2까지 닫았다 — staged claim

§9.12에서 "별도 단위로 남긴다"고 적은 항목을 같은 밤에 처리했다. 커밋 `01bb0a3`, `3016ad2`.

**문제.** 목적지 디렉터리를 먼저 만들고 identity를 그 다음에 기록했다. 그 사이에 죽은 프로세스는
증명할 수 없는 디렉터리와 그 경로를 쥔 intent를 남긴다. 미입증 객체는 보존한다는 규칙(P1-C2가
요구한 바로 그 규칙)이 옳게 동작한 결과로, 그 목적지는 **이후 모든 주기에서 영구히 거절**된다.
일정화된 보존에서 이것은 보수적인 결과가 아니라 다시는 돌지 않는 lane이다.

**수정.** claim을 목적지가 아니라 **자기 이름 아래** 만든다. 이름은 목적지와 이 실행의 operation id로
유도되므로 복구는 intent 행만으로 철자할 수 있다. identity는 객체가 아직 그 이름 아래 있을 때
기록하고, 목적지로의 `rename`은 같은 inode를 옮기므로 기록된 identity가 이후에도 그 객체를 설명한다.

첫 구현에서 나는 "그 이름은 이 실행만 철자할 수 있으니 거기 있는 것은 우리 것"이라고 적었고, 증명
없이 회수했다. **이것은 P1-C2가 거부한 바로 그 추론이며 읽기 검토가 즉시 잡아냈다.** 지금은 기록된
identity가 그 객체를 여전히 설명할 때만 회수한다. 증명이 없으면 객체는 **그대로 두고** 보고하며,
intent는 그래도 해제한다 — 그 intent가 쥐고 있던 목적지는 애초에 점유된 적이 없고, 그 경로를 이후
모든 실행에 거절하는 것은 아무것도 지키지 못하기 때문이다.

- rename 이전 급사: 목적지는 **건드려지지 않았고**, staged 객체는 복구가 회수한다 → 목적지는 다시 사용 가능.
- rename 이후 급사: 이전과 완전히 동일하다(identity가 있으므로 증명·회수 가능).

**회귀 3건.**

1. identity 기록 **이전** 급사: staged 객체는 **보존**되고(`retained_unproven`), intent는 해제되며,
   **같은 목적지로 다음 실행이 성공**한다.
2. identity 기록 **이후** 급사: 기록된 identity가 그 객체를 설명하므로 복구가 회수한다(`removed_partial`).
3. staged 이름을 **남의 객체가 차지**하고 있으면 복구가 건드리지 않는다(sentinel 바이트 그대로).

변이 검사로 옛 순서(목적지 선점 후 identity)를 복원하면 1번만 실패한다
(`expected true to be false` — 목적지가 존재해 버린다). 목적지에 **빈 디렉터리**가 서 있는 경우도
거절과 보존(inode·내용 불변, intent 0행)을 별도 회귀로 고정했다.

이로써 3차 리뷰가 제기한 P1 3건과 P2 1건이 모두 닫혔다. 남은 P2(중복 JSON 키 last-wins)는 §9.8에
적은 대로 수용한 한계다.

**이 변경이 만든 절충을 숨기지 않는다.** 이전에는 목적지를 `mkdirSync`로 배타 생성했으므로, 그
이름에 무엇이든 있으면 커널이 거절했다. 지금은 rename 직전에 존재를 확인하고 `renameSync`로
옮긴다. Linux의 `rename`은 목적지가 **비어 있는 디렉터리**면 대체하고, 비어 있지 않으면
`ENOTEMPTY`로 실패한다. 따라서 확인과 rename 사이에 **협조하지 않는 프로세스**가 그 경로에 빈
디렉터리를 만들면 그것이 대체될 수 있다. intent 대장을 따르는 실행끼리는 같은 목적지를 동시에
announce할 수 없으므로(UNIQUE) 이 창은 발생하지 않으며, Node에는 `RENAME_NOREPLACE`에 해당하는
API가 없다. 영구 거절이라는 확실한 손해와 이 좁은 창을 견준 판단이며, 판단의 근거를 여기 남긴다.


### 9.16 gate 8회차 실패 1건과 그 처리 (숨기지 않는다)

입력 `57db940`의 전체 gate는 `VERIFY8=1`로 끝났다. 실패는 1건이며 **어서션이 아니라
타임아웃**이었다.

    × local-timeline-snapshot-store > discards cached content through reconstruction and restore
      → Test timed out in 5000ms (5044ms)

원인을 추정하지 않고 측정했다. 같은 머신에서 **같은 코드**로 단독 실행했을 때:

| 조건 | 실측 |
|---|---|
| 현재 코드, 단독 1회 | 3,206ms |
| 현재 코드, 단독 2회 | 3,263ms |
| 이번 라운드의 fresh-builder 규칙을 **제거**하고 1회 | 5,753ms (**실패**) |
| 같은 조건 2회 | 4,809ms |

즉 이번 변경을 빼면 오히려 더 느렸다. 이 케이스를 결정하는 것은 이번 라운드의 코드가 아니라 머신
부하이며, 그 파일의 모든 케이스가 5초 기본값을 상속하는데 이 하나만 실제로 재구성+복원을 수행한다.

처리: **단정은 전혀 건드리지 않고 이 케이스의 기한만 명시**했다(`}, 60_000);`, 이 스위트의 다른 긴
통합 케이스와 같은 관례). 측정치를 주석으로 남겼다. 테스트를 통과시키기 위해 기대값을 바꾸거나
검사를 제거하지 않았다.


### 9.17 전체 gate 9회차 (네 번째 리뷰 이전)

읽기 검토(CODEX-JARVIS-REVIEW-20260912-01)의 P1 수정과 타임아웃 명시까지 포함한 입력이다.

| 항목 | 값 |
|---|---|
| 입력 SHA | `c2e191ab54f657cf5743bea3d8af565895474560` |
| exit code | **0** (`VERIFY9=0`) |
| 종료 시각 | `2026-09-12 01:58:45 +0900` |
| backend shard 1/2 | 279 파일 / 1,932 테스트, 772.52s |
| backend shard 2/2 | 279 파일 / 1,942 테스트, 684.11s |
| dashboard | 38 파일 / 263 테스트, 36.83s |
| 합계 | **596 파일 / 4,137 테스트** |
| architecture | `{"ok":true,"modules":671,"edges":2497,"cycles":[]}` |
| acceptance | `pre_gjc_ready` |
| 로그 | `<QA>/verify9.log`, sha256 `ccc5eab731ea33613f3d051a6ffe2b590cfe4d86916e8f1e0ffc2e7d696240d0` |

전체 gate 실행 이력(9회, 근거로 쓰는 것은 마지막 1회):

| 회차 | 입력 | RC | 처리 |
|---|---|---|---|
| 1 | `320b59c` | 1 | 내 변경이 만든 실패 2건 → 수정 |
| 2 | `5a53e10` | 0 | 이후 코드 변경으로 근거 아님 |
| 3 | `e2ed929` | 143 | 2차 리뷰 재설계 요구로 내가 중단 |
| 4 | `f1e6b14` | 0 | 이후 코드 변경으로 근거 아님 |
| 5 | `ca28dfe` | 0 | 이후 코드 변경으로 근거 아님 |
| 6 | `01bb0a3` | 143 | 모듈 라인 예산 초과를 커밋 뒤 발견해 내가 중단 |
| 7 | `3016ad2` | 0 | 이후 읽기 검토 수정으로 근거 아님 |
| 8 | `57db940` | 1 | 타임아웃 1건(§9.16) |
| 9 | `c2e191a` | **0** | **정본** |


### 9.18 런타임 패키지 9회차 (네 번째 리뷰 이전)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-ZbHKKx` |
| source_head | `c2e191ab54f657cf5743bea3d8af565895474560` — gate 입력과 **같은 SHA** |
| source_dirty | `true`. tracked 수정은 `docs/`뿐, `src/`·`tests/`·`config/`는 0 |
| payload_files / dependency_entries | 1,540 / 6,668 |
| receipt pin (독립 고정) | `805903ce65e6ac0d62664528d035a8c67f5038993549e9618265aa6c208191e0` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified / runtime_validation / deployment_ready | `false` / `not_performed` / **false** |
| 로그 | `<QA>/package4.log`, `<QA>/package4-verify.log` |


### 9.19 네 번째 독립 리뷰 — 지적과 처리 (커밋 `eddadc7`)

범위 `49782df..0515fb1` 전체를 코드와 **이 회신서 주장까지** 감사시켰다. P1 6건·서술 오류 3건.
§0에 열거했던 항목의 처리는 다음과 같다.

| 지적 | 처리 |
|---|---|
| 잔해 배리어 제거가 검사-후-unlink | **커널 잠금으로 직렬화**했다. 배리어를 만들거나 지우는 모든 경로가 SQLite의 EXCLUSIVE 트랜잭션(`<db>.swap-lock`) 아래에서 돈다. 읽기(입장 통제)는 잠금을 잡지 않고 **아무것도 지우지 않는다**. 따라서 "살아 있는 배리어를 잔해로 오인해 지우는" 경주가 사라진다 |
| 형식 깨진 레코드가 영구 거절 / 비정규 파일에서 블록 | 형식이 깨졌거나 정규 파일이 아니면 **살아 있는 배리어일 수 없다**(게시는 항상 완전한 레코드를 링크한다). 그러므로 debris로 판정해 다음 writer가 잠금 아래에서 회수한다. 읽기는 `O_NOFOLLOW|O_NONBLOCK`으로 연다 |
| `/proc`를 읽을 수 없는 같은 UID 프로세스를 건너뜀 | 한 번은 fail-closed로 바꿨으나 **실측에서 제품이 쓸 수 없게 됐다**(공유 계정에는 항상 그런 프로세스가 있어 모든 교체가 거절). 되돌리고 대신 **SQLite 배타 트랜잭션 탐침**을 rename 이전에 넣었다. 그 탐침이 무엇을 잡고 무엇을 못 잡는지는 아래 §9.19.1에 실측으로 적는다 |
| 목적지 확보가 no-replace가 아님 | `existsSync` 대신 **`mkdir`로 이름을 만들어** 확인한다(커널이 무엇이든 있으면 거절). 그 뒤 되돌리고 rename한다. 남는 창과 그 이유(Node에 `RENAME_NOREPLACE` 없음)는 그대로 명시한다 |
| 증명 후 경로로 재귀 삭제 | **격리 이동 후 재확인**으로 바꿨다(`removeProvenDirectory`). 옮긴 객체가 기록된 identity와 다르면 되돌리고 아무것도 지우지 않는다 |
| project scope가 correction dispatch·provider v2·dashboard listing에서 빠짐 | 세 곳 모두 `candidateTaskSourceClosed`를 거치게 했다. outbox 내부 상태 전이는 게이트하지 않았고, 그 이유(단말 효과는 dispatcher와 adapter에서 막힌다)를 여기 적는다 |

구조 회귀가 약하다는 지적도 맞았다. "옛 심볼을 아무도 쓰지 않는다"는 새 소비 지점이 게이트를
빠뜨리는 것을 잡지 못한다. 지금은 correction dispatch와 provider write를 **행동으로** 고정하고,
구조 회귀는 보조로만 남긴다.

실측: 79 파일 / **733 테스트** 통과. 배타성 회귀는 5건이며, 그중 하나는 이번 계약 변경에 맞춰
"읽기는 잔해를 지우지 않는다"와 "다음 writer가 그 이름을 회수한다"를 단정하도록 바꿨다.


### 9.20 이번 제출의 전체 gate (정본)

네 번째 독립 리뷰의 P1 6건을 수정한 입력이다.

| 항목 | 값 |
|---|---|
| 입력 SHA | `eddadc7f6eccbe753bc9d4ade26d0fb2eaba6305` |
| exit code | **0** (`VERIFY10=0`) |
| backend shard 1/2 | 279 파일 / 1,932 테스트, 784.33s |
| backend shard 2/2 | 279 파일 / 1,942 테스트, 693.12s |
| dashboard | 38 파일 / 263 테스트, 36.81s |
| 합계 | **596 파일 / 4,137 테스트** |
| architecture | `{"ok":true,"modules":672,"edges":2502,"cycles":[]}` |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `gjc_dispatched=false` |
| 로그 | `<QA>/verify10.log`, sha256 `bd728e840c997a1685ac7e8570ed29d6c07331b731875c1638bf126794bb0d7e` |

전체 gate 10회 중 근거로 쓰는 것은 이 1회다. 1·8회차는 실패(원인과 수정은 §9.16 및 위 표),
3·6회차는 내가 중단, 2·4·5·7·9회차는 통과했으나 이후 코드가 바뀌어 근거로 쓰지 않는다.


### 9.21 이번 제출의 런타임 패키지 (정본)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-mqurdy` |
| source_head | `eddadc7f6eccbe753bc9d4ade26d0fb2eaba6305` — gate 입력과 같은 SHA |
| source_dirty | `true`. receipt는 이 값만 기록하며 구성은 설명하지 않는다. 별도로 확인한 `git status`에서 tracked 수정은 `docs/`뿐이고 `src/`·`tests/`·`config/`는 0이다 |
| payload_files / dependency_entries | 1,541 / 6,668 |
| receipt pin (독립 고정) | `b123271d4ed0eada5023251545139312de40c58f604f89c632118f37f8813618` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified / runtime_validation / deployment_ready | `false` / `not_performed` / **false** |

### 9.22 이 시점의 상태 판단

> **정정(2026-09-12).** 아래 문단은 다섯 번째 리뷰 시점의 판단이다. 이후 여섯·일곱 번째 검토에서
> writer 배타성 항목은 다시 열렸고, 현재 정본 판단은 §9.28 과 §0 의 갱신 블록이다.

§0은 네 번째 리뷰가 P1을 열어둔 동안 `IN_PROGRESS`로 되돌렸다. 그 6건은 `eddadc7`에서
모두 닫혔고(§9.19), 같은 입력으로 전체 gate가 RC 0(§9.20)이며 패키지도 검증됐다(§9.21). 서술 오류
3건도 각각 고쳤다: §1의 tree 확인 명령, §9.15의 "모두 닫았다", §9.21의 `source_dirty` 설명.

그러나 **다섯 번째 리뷰는 아직 받지 않았다.** 이번 라운드에서 네 번의 독립 검토가 모두 실제 P1을
찾아냈고, 그 사실 자체가 "이제 없다"고 말할 근거를 약하게 만든다. 그래서 이 문서는 상태를
`READY_FOR_CODEX_FINAL_REVIEW_WITH_EXTERNAL_BLOCKERS`로 올리되, **그 근거는 "결함이 없다"가
아니라 "내가 아는 모든 지적이 닫혔고 각각 회귀로 고정됐으며 전체 gate와 패키지가 같은 SHA에서
통과했다"**임을 분명히 한다. 다음 검토가 새 지적을 내면 그것은 이 문서의 실패가 아니라 이 절차가
의도한 대로 동작한 것이다.


#### 9.19.1 SQLite 탐침이 실제로 무엇을 증명하는가 (내가 측정해서 정정한다)

탐침을 넣고 나서 "writer는 잠금에서 숨을 수 없다"고 썼다. **그 서술은 과장이었다.** 격리 측정으로
확인한 결과는 다음과 같다(authority DB는 WAL 모드다).

| 상황 | 탐침이 잡는가 |
|---|---|
| 우리 자신의 연결이 열려 있음 | 아니오 (교체 시점에는 이미 닫혀 있으므로 무관) |
| 모두 닫힌 상태 | 아니오 (정상 통과) |
| **다른 연결이 열려 있고 유휴** | **아니오** |
| 다른 연결이 **쓰기 트랜잭션 중** | **예** |

WAL에서 `BEGIN EXCLUSIVE`는 다른 연결이 **쓰기 잠금을 쥐고 있을 때만** 막힌다. 열려만 있는
연결은 잠금을 쥐지 않으므로 보이지 않는다. 따라서 탐침이 더하는 것은 "지금 쓰고 있는 writer를,
`/proc`가 그 프로세스를 못 읽더라도 잡는다"이고, "열려 있는 모든 연결을 안다"가 아니다.

정확한 계약은 세 가지의 합이며, 어느 하나도 단독으로 충분하지 않다.

1. **배리어**: 협조하는 프로세스는 교체 중 이 DB를 **열 수 없다**. 이것이 주된 배제다.
2. **`/proc` 스캔**: 읽을 수 있는 프로세스가 쥔 디스크립터를 본다. **유휴 연결도 본다** — 실제
   별도 프로세스가 연결만 열어둔 상태에서 측정했고, `fd_count 1`·`writable_holders 1`로
   잡혔다. 읽을 수 없는 프로세스는 보지 못한다.
3. **SQLite 탐침**: 쓰기 중인 연결을 본다. `/proc`를 읽을 수 없어도 본다.

남는 구멍은 정확히 하나다: **`/proc`를 읽을 수 없는 프로세스가 이 DB를 열어두고 지금은 쓰지 않는
경우.** 그런 프로세스는 협조하지 않는 프로세스이며, 이 도구들로는 탐지할 수 없다. 숨기지 않고
적는다.

### 9.23 다섯 번째 검토의 두 요구를 실제로 구현하고 측정했다

검토(CODEX-JARVIS-REVIEW-20260912-02, 그리고 5차 독립 리뷰)는 두 가지를 요구했다. 둘 다 **말이 아니라
코드로 구현해서 실행했고**, 그 결과를 그대로 적는다.

**요구 1 — "배제를 증명할 수 없으면 파괴 이전에 거절하라."**
`discoverOpenInodeHolders`가 디스크립터를 읽을 수 없는 같은 UID 프로세스를 `unprovable`로
보고하게 만들고, 그 목록이 비어 있지 않으면 retention·compaction 교체가
`LOCAL_RETENTION_EXCLUSION_UNPROVABLE` / `MEMORY_SOURCE_WRITER_ACTIVE`로 거절하도록 했다.

실행 결과: **이 호스트에서 모든 교체가 항상 거절됐다.** 공유 계정에는 읽을 수 없는 같은 UID
프로세스가 상시 존재하기 때문이다(측정된 실패 예: `process observation failed: 1040584`). 기존
인수 회귀 16건이 그 즉시 실패했다 — 교체가 성공해야 하는 케이스들이다.

이것은 구현 실패가 아니라 **요구된 계약이 이 배포 형태에서 만족 불가능하다는 측정**이다. "세상의
모든 프로세스를 열거할 수 있다"는 전제가 성립하지 않으면 그 규칙은 "항상 거절"과 같다. 따라서
되돌렸고, `unprovable` 보고 자체는 남겨 두었다(운영자가 볼 수 있고, 뒤에 올 결정의 입력이 된다).

**이 항목은 내가 임의로 닫지 않는다. 소유자/운영 결정이 필요하다.** 선택지는 둘이다.
(a) retention·compaction 레인을 **모든 프로세스를 조사할 수 있는 경계**(전용 사용자 또는 PID
namespace)에서 돌린다. 그러면 위 규칙이 의미를 갖고, 거절은 실제 위험이 있을 때만 일어난다.
(b) 계약을 "배리어 + SQLite 잠금 + 가시적 holder 스캔"으로 두고 남는 구멍(§9.19.1)을 명시한 채
수용한다. 현재 코드는 (b)이며, (a)로 가는 변경은 이미 작성해 봤으므로 재적용은 작은 작업이다.

**요구 2 — "목적지에 rename하지 말라(no-replace가 아니므로)."**
운영이 처음부터 끝까지 staged 이름 아래에서만 살고 목적지는 **생성하지 않는** 형태로 바꿔 실행했다.
결과: 6개 파일 **16건**이 실패했다. 목적지 디렉터리를 계약으로 삼는 기존 인수(급사 복구의 정지점,
일정 서비스의 blocked 판정, "이 경로의 파일을 보존한다", "두 호출 중 하나만 목적지를 가진다")가
그 이름의 존재를 전제하기 때문이다.

즉 이 변경은 **retention 경로 계약 전체를 함께 바꾸는 독립 단위**이며, 그 크기를 측정했다. 지금
트리는 되돌린 상태이고, 남는 위험은 "검사~rename 사이에 비협조 프로세스가 만든 **빈** 디렉터리를
대체할 수 있다" 하나로 한정된다. 이것을 수용한 한계로 적지 않고, **다음 단위의 작업 항목**으로 둔다.


### 9.24 gate 12·13이 잡은 타이밍 의존 1건 (제품 결함 아님, 테스트 결함)

같은 입력으로 전체 gate를 두 번 돌렸고 **두 번 다 같은 1건만** 실패했다.

    × GJC runtime ownership > reacquires an expired lease with a new fence
      → expected { fence: 1 } to deeply equal { fence: 2 }

단독 실행에서는 2회 연속 통과했다. 추측하지 않고 코드를 읽어 메커니즘을 확정했다.
`src/service.ts`의 주기는 하트비트 시각을 **주입된 시각 + 실제 경과 ms**로 만들고
(`Math.floor(performance.now() - cycleStarted)`), 하트비트는 lease를 그 시각 + 60초까지 늘린다.

테스트는 첫 주기를 `00:00:00.000Z`에 돌리고 두 번째를 **정확히** `00:01:00.000Z`에 부른다.
`claimGjcRuntimeLease`는 `expires_at > now`면 재획득하지 않으므로, 첫 주기가 1ms라도
걸리면 만료가 `00:01:00.000Z`보다 뒤가 되어 재획득이 일어나지 않는다. 즉 **이 케이스는 첫 주기가
1ms 미만일 때만 통과**했다. shard 부하에서 실패하고 단독에서 통과한 이유가 그것이다.

고친 것은 제품이 아니라 테스트의 그 시각 하나다(`00:02:00.000Z`). 검증 대상은 그대로이며
— 만료된 lease는 새 fence로 재획득된다 — 더 이상 머신 속도에 기대지 않는다. 수정 후 단독 3회 연속
통과했고, 전체 gate를 다시 돌려 확인한다. 이번 라운드의 변경과 이 테스트 사이에는 참조가 없다.


### 9.25 이번 제출의 전체 gate (정본) 과 그 앞의 오염된 실행들

| 항목 | 값 |
|---|---|
| 입력 SHA | `1c709871e0c739686dbeb77c91178a7781055031` |
| exit code | **0** (`VERIFY17=0`) |
| 종료 시각 | `2026-09-12 04:15:59 +0900` |
| backend shard 1/2 | 279 파일 / 1,932 테스트 |
| backend shard 2/2 | 279 파일 / 1,942 테스트 |
| dashboard | 38 파일 / 263 테스트 |
| 합계 | **596 파일 / 4,137 테스트** |
| architecture | `{"ok":true,"modules":672,"edges":2503,"cycles":[]}` |
| acceptance | `pre_gjc_ready` |
| 로그 | `<QA>/verify17.log`, sha256 `93f2db727b4fd50019c8adcfd4a1864bae7b06c7b956d595b92fd0af2c652265` |

**이 실행 직전의 실패들은 제품이 아니라 내 실행 환경이 원인이었다.** gate 12·13은 lease 경계값
타이밍(§9.24) 때문에 같은 1건에서 실패했고, gate 14는 서로 무관한 3건에서 실패했다. 원인을 찾다가
프로세스를 실측했더니 **내가 앞서 중단한 gate의 고아 vitest 워커가 경과 9분·6분짜리로 살아 있었고
load average가 8.39**였다. 고아는 같은 UID로 임시 DB를 열어둔 채였고, 교체 후 검사는 파일을
(device, inode)로 식별하는데 **삭제된 inode 번호는 재사용**되므로 `OLD_DATABASE_FD_ACTIVE` 오탐이
생길 수 있다. 고아를 모두 정리하고 gate를 **단독으로** 돌린 것이 위 표이며, 그 전에는 8코어에 load 8,
그 뒤에는 4 안팎이었다.

실행 이력(17회) 중 근거로 쓰는 것은 이 1회다. 나머지는 실패했거나(원인과 수정은 §9.16·§9.24),
내가 중단했거나, 이후 코드가 바뀌었거나, **위와 같이 오염된 환경에서 돌았다.** 오염된 실행을 통과로
바꿔 적지 않는다.

**실행 규칙으로 남긴다**: gate를 중단할 때 `pkill -f run-tests.mjs`만으로는 워커가 남는다.
`vitest`·`tinypool` 자식까지 정리하고 다음 측정 전에 `ps`로 0을 확인한다.


### 9.26 이번 제출의 런타임 패키지 (정본)

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-U83OKE` |
| source_head | `1c709871e0c739686dbeb77c91178a7781055031` — gate 입력과 같은 SHA |
| payload_files / dependency_entries | 1,541 / 6,668 |
| receipt pin (독립 고정) | `a22b8a7b83cf61ec7d3881d9e625cc7c95862ea9d628326dfdf8f3123a2d3f33` |
| verify-runtime-package | `ok=true`, `integrity="matched"`, RC 0 |
| signature_verified / runtime_validation / deployment_ready | `false` / `not_performed` / **false** |
| source_dirty | `true`. receipt는 이 값만 기록한다. 별도 확인한 `git status`에서 tracked 수정은 `docs/` 1건뿐이었다 |


### 9.27 목적지 계약 변경을 다음 단위로 남기는 이유와 그 사양

§9.23에서 "다음 단위"로 적은 항목을 이 밤에 두 번 구현해 보고 두 번 다 범위를 실측했다. 결과는
같다: **이것은 retention 경로 계약 전체의 이주이지 한 파일의 수정이 아니다.**

운영이 staged 이름 아래에서만 살면 candidate 경로에 operation UUID가 들어간다. 그러면 테스트는
**실행 전에 경로를 예측할 수 없다.** 지금 회귀는 그 예측에 기대고 있다: 급사 픽스처는 목적지 경로를
argv로 받고, 일정 서비스 테스트는 `<db>.retention-candidate/candidate.sqlite`를 직접 만들며,
복구 테스트는 그 이름으로 sentinel을 놓는다. 실측 영향은 **6파일 16건**이고, 오늘 재현한 실패 목록은
`qa/fix20.log`에 있다.

그래서 **지금은 되돌렸다.** 마지막 시간에 green·제출 가능한 트리를 흔들어 반쯤 바뀐 상태로 넘기는
것이 남는 위험보다 나쁘다. 남는 위험은 정확히 하나이고 이미 좁다: 검사와 rename 사이에 **비협조
프로세스가** 목적지에 만든 **빈 디렉터리**가 대체될 수 있다(협조 실행끼리는 intent UNIQUE가 막는다).

다음 단위는 이 사양으로 시작하면 된다.

1. `claimRetentionOperation(staged)`이 staged만 만들고 `takeRetentionDestination`은 삭제한다.
   목적지는 대장에 announce만 하고 생성하지 않는다.
2. 테스트는 경로를 **예측하지 말고 읽는다**: `application.operation.candidate_path` 또는
   `SELECT candidate_path FROM local_retention_operations`.
3. 급사 픽스처는 목적지 대신 **announce할 이름**을 받고, 부모는 자식이 죽은 뒤 대장에서 실제 경로를
   읽는다.
4. "목적지에 있던 남의 파일을 보존한다"는 계약은 그대로 유지된다 — 그 경로는 이제 **아예 만들어지지
   않기 때문**이며, 회귀도 그 사실을 단정하도록 바꾼다.
5. 일정 서비스의 `blocked` 판정은 목적지 존재가 아니라 미완료 operation 행으로 판정한다(이미 그렇다).

### 9.28 여섯 번째·일곱 번째 검토 (REVIEW-20260912-01/-02/-03) 와 그 처리

| 항목 | 실측 |
| --- | --- |
| 제품 SHA | `b94468796c8cb766d557039f32a7c3b41fc6a07c` |
| 전체 gate | `VERIFY20=0` (backend 279 파일 / 1,942 케이스, dashboard 38 파일 / 263 케이스) |
| 런타임 패키지 | `jarvis-runtime-ec1enI`, `source_head=b944687…`, payload 1,541, receipt `94c27ebd…`, `integrity=matched`, `deployment_ready=false` |
| manifest | `gate_input_sha=b944687…`, 아티팩트 40, 누락 0 |

**닫힌 것 — 기존 목적지 보존 (REVIEW-01).** `claimRetentionOperation` 은 이제 staged 디렉터리만 만들고,
announce된 목적지는 생성·점유·교체하지 않는다(`takeRetentionDestination` 제거, 커밋 `9fb366a`). mkdir→rmdir→rename
경로 자체가 사라졌으므로 "빈 목적지 교체" 지적은 구조적으로 닫힌다. 회귀는 기존 목적지의 세 형태(파일 byte 단위,
빈 디렉터리, 비어있지 않은 디렉터리) 와 stale sidecar, 경합하는 두 호출을 모두 고정한다. 테스트는 경로를 예측하지
않고 대장에서 읽는다(`application.operation.candidate_path`).

**좁혔으나 닫지 못한 것 — writer 배타성 (REVIEW-02/-03).** 커밋 `b4927fb` 는 rename 직전에 마지막 배타성 질문을
추가한다. 이것은 창을 **좁힐 뿐 봉쇄하지 않는다**: 마지막 검사와 `renameSync` 는 별개 호출이고, 검사 통과 이후 진입한
비협조 writer는 여전히 배제되지 않는다. 회귀는 "그 시점 관측이 보유자를 보고하면 거절한다" 만 증명하며,
변이 검사로 변별력을 확인했다(블록 제거 시 `promise resolved instead of rejecting` 로 실패).
앞선 "sealed" 표현은 과장이었고 정정했다.

**증명 불가 시 거절 — 두 구현을 실제로 만들고 측정한 뒤 되돌렸다.**

1. 구멍이 있으면 무조건 거절: 이 호스트의 같은 UID 프로세스 500개 중 23개가 `/proc/<pid>/fd` 판독 불가
   (systemd --user, sd-pam, gpg-agent — dumpable=0). 결과는 **모든 swap 거절**(9개 이상 pid를 나열).
   항상 거절하는 계약은 계약이 아니다.
2. inode 생성 시각으로 구멍을 좁힘: 생성 이전에 시작된 숨은 프로세스는 그 inode의 기존 fd를 가질 수 없다는 근거.
   결과는 여전히 거절 — 테스트 데이터베이스 생성 **이후** 시작되는 숨은 프로세스가 실제로 존재하므로 술어가
   환경·타이밍 의존이 되어 gate를 흔든다. 또한 `chmod` 가 ctime을 바꾸는 탓에 mode 케이스는 소스 fence의
   `LOCAL_RETENTION_SOURCE_CHANGED` 에 먼저 걸려 검사에 도달조차 하지 못했다.

이 측정이 말하는 것은 "Node API가 없다" 가 아니다. `/proc` 은 하드닝된 같은 UID 프로세스에 대해 **답 자체를 주지
않으며**, 그 위에 세운 술어는 항상 거절하거나 타이밍으로 거절한다. 남은 설계는 관측이 아니라 **프로토콜**이다:
모든 연결이 `openUnderSwapAdmission` 을 통과해 등록되고, swap 은 보이는 모든 디스크립터가 등록된 경우에만
진행하며(등록되지 않은 가시 디스크립터는 이미 오늘도 거절한다), 파일이 이 사용자 밖에서 열릴 수 없음을 mode/owner로
함께 요구한다. 잔여는 admission 없이 연 숨은 프로세스이며, 이는 커널 측 답(없음) 또는 데이터베이스를 프로토콜
밖에서 열 수 없게 만드는 변경을 요구한다. 특권 프로세스는 어떤 사용자 공간 프로토콜로도 배제할 수 없으며,
이는 계약의 **명시된 한계**로 남기고 가정으로 숨기지 않는다.

**따라서 REVIEW-20260912-02 와 -03 은 열린 상태로 유지한다.**

### 9.29 증명 가능한 절반은 실제로 착지시켰다 (커밋 `8c245d8`)

`exclusionHole(filename)` 은 두 swap 경로에서 **sidecar 제거 이전에** 묻는다: 소스가 이 사용자 밖 소유이거나
외부 쓰기 가능이면 `LOCAL_RETENTION_EXCLUSION_UNPROVABLE` / `MEMORY_EXCLUSION_UNPROVABLE` 로 거절한다.
이것은 §9.28 의 시도 A 중 측정을 견딘 부분이다 — 파일 자체의 성질이므로 `/proc` 을 보지 않고, 따라서 항상
거절하지도 타이밍에 의존하지도 않는다.

회귀는 fence 이전에 `chmod 0666` 을 걸어 거절을 확인하고, 그 시점에 소스·WAL·후보가 모두 남아 있고 barrier 가
없음을 함께 고정한다. 이어서 `chmod 0600` 후에는 **새로 만든** 후보가 설치된다 — 거절된 시도가 소스의 fence 를
지나가므로 재시도는 후보를 다시 만들어야 하며, 이는 제품 동작이라 우회하지 않고 그대로 고정했다.
변이 검사: 이 블록을 지우면 `promise resolved instead of rejecting` 으로 실패한다. `fix31.log` 7 passed (7).

여전히 열린 잔여는 그대로다: admission 없이 데이터베이스를 연 숨은 같은 UID 프로세스(이 호스트 23개)와 특권
프로세스. 이 둘은 또 다른 탐침이 아니라 §9.28 의 admission 프로토콜 설계를 요구한다.

| 최종 실측 | 값 |
| --- | --- |
| 제품 SHA | `8c245d8c0e57b1f548c8307f1ea3f4787b2c3763` |
| 전체 gate | `VERIFY21=0` (backend 279 / 1,942, dashboard 38 / 263) |
| 패키지 | `jarvis-runtime-GFqQk1`, `source_head=8c245d8…`, payload 1,541, receipt `3dada57e…`, `integrity=matched`, `deployment_ready=false` |

### 9.30 기본값을 거절로 올렸다 (커밋 `a1f7c31`, `c67a139`)

`exclusionHole(filename, observed)` 은 이제 관측에 **구멍이 있으면** — 이 사용자 소유인데 `/proc` 을 읽을 수 없는
프로세스가 하나라도 있으면 — 파괴 이전에 거절한다. 소유자·외부 쓰기 권한 조건도 함께 유지된다. §9.28 에서
"항상 거절한다"는 이유로 되돌렸던 판단을 뒤집었다: 성공을 가정하던 테스트가 깨진다는 것은 안전 기준을 낮출
이유가 아니라, **허용 조건을 명시적으로 세우라는 요구**다.

- 새 seam `AuthorityDatabaseRuntime.observeExclusion(device, inode)` 은 관측자에서 직접 답을 취한다.
  런타임의 post-rename 관측은 swap 의 다른 단계이므로 한 호출로 합치지 않는다 — 이 규칙이 깨졌을 때
  기존 compaction 테스트의 `mockImplementationOnce` 가 앞당겨 소비됐고, 우회가 아니라 그 규칙을 지켜 고쳤다.
- 허용 조건은 `tests/fixtures/provable-exclusion.ts` 의 `withProvableExclusion(runtime)` 으로 **선언**한다.
  정산 대상은 판독 불가 프로세스뿐이며, 관측된 보유자는 그대로 두므로 실제 보유자에 대한 거절은 모두 그대로
  발화한다. 적용 지점은 retention exclusivity·schedule·recovery, memory cancellation compaction·real-process
  driver·correction control fixture, 급사 자식 프로세스, 반사적 memory-authority-compaction — 8곳이다.
- **거절 보존 인수**는 seam 없이 이 호스트의 실제 답으로 돈다: 거절이 일어나고 소스 inode·행 수·WAL·후보가
  모두 남고 barrier 가 남지 않는 것을 확인한다. 완전한 답을 주는 호스트에서는 진행을 허용한다(같은 케이스가
  분기한다). 변이 검사: 구멍 분기를 지우면 `promise resolved instead of rejecting` 으로 실패한다.

| 최종 실측 | 값 |
| --- | --- |
| 제품 SHA | `c67a139261b5b92071a77794fefda5443dee66b7` |
| 전체 gate | `VERIFY23=0` (backend 279 / 1,942, dashboard 38 / 263) |
| 패키지 | `jarvis-runtime-JPQBPL`, `source_head=c67a139…`, payload 1,542, receipt `bb0f7f26…`, `integrity=matched`, `deployment_ready=false` |

남은 잔여는 하나다: admission 없이 데이터베이스를 연 **숨은** 프로세스와 특권 프로세스. 전자는 이제 거절로
**막히지만**(구멍이 있으면 교체하지 않는다) 배제된 것은 아니며, 후자는 사용자 공간 프로토콜의 명시된 한계다.

### 9.31 open/reopen 진입점을 목록화하고 공통 경계에 묶었다 (커밋 `4c0e793`)

통합 지시서 M2 의 "모든 지원 writer·open/reopen 진입점을 목록화하고 가장 작은 일관된 경계에서 공통 계약을
적용한다" 를 코드로 옮겼다. `src` 전체에서 데이터베이스를 여는 지점은 8곳이다.

| 지점 | 처리 |
| --- | --- |
| `authority-db-base.ts` (생성자·reopen) | 이미 `openUnderSwapAdmission` |
| `cli-runtime-identity.ts`, `personal-os-backup.ts` (온라인 백업 소스) | 이미 admission |
| `authority-database-swap-lock.ts` | swap 자신의 락 파일 — 라이브 권한 DB 아님 (이름으로 명시) |
| `local-observation-retention-operation.ts` | 빌드 중인 candidate — 아직 라이브 아님 (명시) |
| `local-observation-retention-swap.ts` | swap 이 barrier 를 쥔 채 쓰는 락 탐침 (명시) |
| `personal-os-backup.ts` (quick_check) | 목적지의 백업 사본 (명시) |
| `personal-os-process-stress.ts`, `personal-os-rehearsal-payload.ts` ×2, `personal-os-rehearsal.ts` | **무등록 open 이었다 → admission 통과로 변경** |

`tests/unit/authority-open-admission.test.ts` 가 이 경계를 고정한다. admission 을 거치지도, 목록에 이름이 있지도
않은 새 open 이 생기면 실패한다. 그리고 목록에 적힌 파일이 데이터베이스를 더 이상 열지 않게 되면 목록에서도
빠져야 하므로, 이것은 억제 목록이 아니라 **열거**다. personal-os 스위트 27 파일 / 135 케이스 통과.

| 최종 실측 | 값 |
| --- | --- |
| 제품 SHA | `4c0e793b0bb77f4f6bdce2862764b5de03d53d61` |
| 전체 gate | `VERIFY24=0` (backend 279 / 1,942, dashboard 38 / 263) |
| 패키지 | `jarvis-runtime-Yi1OYT`, payload 1,543, receipt `619b5f67…`, `integrity=matched`, `deployment_ready=false` |

### 9.32 검사 이후 진입은 배제가 아니라 보존으로 다룬다 (커밋 `39c89f1`, `6caf4ee`)

여섯 번째 검토(REVIEW-04)의 지적을 그대로 받는다. `observeExclusion` 은 **순간 관측**이고 마지막 검사와
`renameSync` 는 별개 호출이므로, `unprovable=[]` 인 호스트에서도 관측 이후 admission 을 따르지 않는 같은 UID
writer 의 진입은 배제되지 않는다. 그리고 `tests/fixtures/provable-exclusion.ts` 의 주입은 **모의 허용 조건**이지
OS 격리 증명이 아니다 — 그 사실을 헬퍼 주석 자체에 적었다.

그래서 배제할 수 없는 구간은 **파괴하지 않는 것**으로 바꿨다. retention swap 의 파괴 단계 두 곳이 퇴거가 된다.

- 사이드카는 삭제하지 않고 `<db>.<operation>.retired-wal` / `-shm` 으로 rename 한다.
- 소스는 rename 으로 덮이지 않고 `<db>.<operation>.retired` 로 먼저 물러난 뒤, 후보가 라이브 이름을 가져간다.

마지막 질문 이후에 열린 디스크립터는 디렉터리 엔트리가 남아 있는 파일에 쓰게 되고, 그 커밋은 파일로 읽어낼 수
있는 상태로 남는다. `memory-authority-swap` 이 이미 쓰던 계약과 같은 형태다.

**인수는 실제 writer 로 한다.** 창 안에서 두 번째 SQLite 연결을 동기적으로 열어 실제로 한 행을 commit 하고
(모의 관측이 아니라 SQLite 가 파일에 쓴다), swap 이 끝난 뒤 퇴거된 데이터베이스에 그 행이 있는지 확인한다.
변이 검사: 소스 퇴거 rename 을 지우면 이 인수가 실패한다. retention 스위트 76/76.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `6caf4eed45ead2b9beb25f670e2d915881522a06` |
| 전체 gate | `VERIFY26=0` (backend 279 / 1,942, dashboard 38 / 263), 종료 09:03 KST |
| 직전 gate | `VERIFY25=1` — `39c89f1` 입력, 원인은 삭제 제거로 남은 미사용 import 1건(제품 결함 아님), `6caf4ee` 에서 제거 |
| 패키지 | `jarvis-runtime-3eKSfQ`, `source_head=6caf4ee…`, payload 1,543, receipt `00fb9b7d…`, `integrity=matched`, `deployment_ready=false` |

### 9.33 일곱 번째 검토(REVIEW-05)가 잡은 퇴거 계약의 두 결함

둘 다 실재하는 제품 결함이었고, 코드 경로 지적만으로 재현 없이 확인됐다.

**P1-R1 — 두 rename 사이에 live 경로가 없었다.** 소스를 먼저 옮기고 후보를 나중에 옮기면 그 사이에 죽은
프로세스는 live 경로가 **없는** 상태를 남긴다. 더 나쁜 것은 그 상태에서 `AuthorityDb.reopen()` 이
`fileMustExist` 없이 열어 **빈 권한 데이터베이스를 새로 만들 수 있었다**는 점이다.

- 퇴거 이름은 이제 이동이 아니라 `linkSync` 로 만드는 **두 번째 링크**다. inode 는 이름을 잃지 않고, publish 는
  live 경로 위의 단일 원자적 rename 이므로 live 경로가 사라지는 순간이 없다.
- `reopen()` 은 `fileMustExist: true` 로 연다. 끝나지 않은 교체를 조용히 빈 DB 로 덮는 대신 실패한다.
- 인수는 중단 상태를 정확히 구성한다: 퇴거 링크가 있고 후보가 publish 되지 않은 상태에서 live 경로가 여전히
  원래 inode 이고 행 수가 그대로임을 확인하고, live 경로를 지운 뒤 `reopen()` 이 던지는 것과, 퇴거 링크에서
  복원하면 원래 inode·행 수로 돌아오는 것까지 확인한다. 변이 검사: `fileMustExist` 를 지우면 실패한다.

**P1-R2 — 기존 훅은 최종 창을 입증하지 못했다.** 후보 존재만 조건으로 삼아 `foreignHolders` 단계의 첫 관측에서
발화했고, writer 를 즉시 닫아 열린 WAL 을 남기지 않았다. 조건을 **후보 안의 applied 레코드**로 바꿔 최종 검사
그 한 번에만 발화하게 했고, writer 는 WAL 을 쥔 채 publish 를 넘긴다.

이 인수가 세 번째 결함을 드러냈다: 검사 이후 writer 가 만든 로그가 **publish 된 새 데이터베이스에 붙어**
`database disk image is malformed` 가 됐다. 사이드카 퇴거를 publish **이후**로 옮겨 퇴거된 inode 와 짝이 맞게
했고, barrier 가 아직 서 있는 동안 수행하므로 승인된 연결은 그 사이를 보지 못한다. 변이 검사: 되돌리면 실패한다.

그리고 이 경우 swap 은 publish 를 마친 뒤 `LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE` 로 **보고**한다. 침묵이
아니고 손실도 아니다 — 퇴거된 데이터베이스와 그 로그에서 그 writer 의 커밋을 그대로 읽어낼 수 있다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `e3c2f0439504bb64a8af0947e2beb589f0515f23` |
| 전체 gate | `VERIFY29=0` (backend 279 / 1,942, dashboard 38 / 263), 종료 10:34 KST |
| 직전 gate | `VERIFY27=1` (미사용 바인딩 1건), `VERIFY28=1` (스케줄 1건 `status: failed`, 단독 5/5 통과·자체 부하 재현 실패·vitest diff 가 코드를 생략해 귀속 불가) |
| 그 처리 | 사유를 추측하지 않고, 실패한 cycle 이 자기 코드를 보고하도록 단언을 강화(`e3c2f04`). 동일 입력 gate 반복은 하지 않았다 |
| 패키지 | `jarvis-runtime-All4Eo`, `source_head=e3c2f04…`, payload 1,543, receipt `b417cf1e…`, `integrity=matched`, `deployment_ready=false` |

### 9.34 P1-R3 — publish 와 로그 이동 사이의 중단 (커밋 `0b1c57d`)

여덟 번째 검토가 짚은 대로, publish 직후 사이드카가 옮겨지기 전에 죽으면 **새 main + 옛 WAL** 의 혼합 상태가
남는다. 그 뒤 catch 가 reopen 하고 barrier 를 풀며, 죽은 owner 의 barrier 는 debris 로 취급돼 다음 open 이
허용되므로, 그 혼합 상태가 그대로 노출된다. 기존 인수는 publish **이전** hardlink 상태만 구성했으므로 이
구간을 검증하지 않았다.

**phase 증거로 처리했다.** publish 직전에 `<db>.publishing` 을 쓴다 — operation id, 퇴거 경로, publish 될
inode 정체성, 퇴거될 inode 정체성. 그리고 **연결이 만들어지기 전에**(`openUnderSwapAdmission`) 정산한다.

- live 경로가 기록된 publish inode면: 그 이름 아래 남은 로그는 퇴거된 inode 의 것이므로 짝이 맞는 이름으로
  옮기고 기록을 지운다 → `completed`.
- live 경로가 퇴거될 inode면: publish 자체가 없었으므로 **아무것도 옮기지 않고** 기록만 정리한다 → `reverted`.
- 둘 다 아니면 `unproven`: 이름이 무엇이든 그 로그가 누구 것인지 말할 수 없으므로 손대지 않는다.

파일을 지우지 않고, 살아 있는 barrier 도 믿지 않는다. 판단 근거는 dev/ino 정체성뿐이다.

**변이 검사 둘 다 갈린다.** 정산 호출을 지우면 혼합 상태가 그대로 열려 `malformed database schema` 로
실패하고, 정체성 판정을 무조건 참으로 바꾸면 publish 가 없었던 경우에 live 데이터베이스 자신의 로그를
빼앗아 `disk I/O error` 로 실패한다. 후자를 잡기 위해 "publish 가 없었는데 기록만 있는" 케이스를 따로 세웠다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `0b1c57d83d7312a8e5f1f5cdea3f47f1954542f4` |
| 전체 gate | `VERIFY30=0` (backend 279 / 1,942, dashboard 38 / 263), 종료 11:36 KST |
| 패키지 | `jarvis-runtime-5hx5Ww`, `source_head=0b1c57d…`, payload 1,544, receipt `b584a752…`, `integrity=matched`, `deployment_ready=false` |
| manifest 복구 | round 5=`eRhLO4`(ca28dfe), round 9=`ZbHKKx`(c2e191a), round 10 final=`O25Nzv`(b6403f7) 를 각자의 패키지로 되돌리고, gate29(`All4Eo`)·gate30(`5hx5Ww`) 을 각각 별도 항목으로 연결 |

### 9.35 아홉 번째 검토 — phase 구현 자체의 두 결함 (커밋 `8c214c0`)

**(1) `unproven` 을 무시하고 열었다.** 정산이 "이 로그가 누구 것인지 말할 수 없다" 고 답해도
`openUnderSwapAdmission` 은 그대로 `assertSwapAdmission` 으로 넘어갔다. barrier 가 없거나 죽은 owner 의
것이면 혼합 데이터베이스가 그대로 열렸다. 이제 `AUTHORITY_DATABASE_PUBLISH_UNSETTLED` 로 **거절**한다.
회귀는 정체성 불일치 기록과 malformed JSON 두 경우에서 open 콜백이 한 번도 실행되지 않고 기록·데이터베이스·
후보가 모두 그대로임을 고정한다.

**(2) 정산이 소유자 직렬화 경계 밖에서 돌았다.** `beginPublishPhase` 뒤 rename 전에 멈춘 **살아 있는**
publisher 의 기록을, 다른 admitted opener 가 `retired_identity` 분기로 지운 뒤 barrier 때문에 거절될 수 있었다.
그러면 원래 publisher 는 기록 없이 publish 하게 되고, 직후 급사하면 R3 가 그대로 다시 열린다. publish 뒤였다면
사이드카 이동을 active owner 와 경쟁한다.

정산은 이제 barrier 가 발행되는 것과 **같은 잠금**(`withSwapBarrierLock(canonicalDatabase(...))`) 안에서만
일어나고, 살아 있는 외부 소유자가 barrier 를 쥐고 있으면 `owned` 로 물러나 기록도 사이드카도 건드리지 않는다.
복구하려는 opener 가 둘이어도 같은 잠금에서 직렬화되므로 이동은 한 번만 일어난다. 호출 순서를 바꾼 것이
아니라 경계를 맞춘 것이다.

회귀는 **실제 다른 프로세스**가 barrier 를 쥔 상태를 쓴다. 이 프로세스 자신의 barrier 는 소유자로 admit 되므로
그 가드를 전혀 건드리지 못하기 때문이다(holder fixture `abandon`).

변이 검사 둘 다 갈린다: 거절을 지우면 열려버리고, 소유자 가드를 지우면 살아 있는 publisher 의 기록이 지워진다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `8c214c0951e13a507e4988b691947394f2315966` |
| 전체 gate | `VERIFY31=0` (backend 279 / 1,942, dashboard 38 / 263), 종료 12:33 KST |
| 패키지 | `jarvis-runtime-kEmdpu`, `source_head=8c214c0…`, payload 1,544, receipt `e20deec1…`, `integrity=matched`, `deployment_ready=false` |

### 9.36 열 번째 검토 — 저장된 manifest 실측과 소유자 급사 경합 (커밋 `e6c63be`)

**manifest: 내 이전 주장이 틀렸다.** "과거 패키지 복원 완료" 라고 적었지만, **저장된**
`final-manifest.json` 의 `gates[].package_root` 는 여전히 네 항목 모두 `All4Eo` 였다. 내가 고친 것은
아티팩트 경로뿐이었고, 생성 스크립트의 문자열 치환이 성공한 것을 결과 검증으로 착각했다.

이번에는 **쓰여진 파일을 다시 읽어** 각 `package_root` 의 `receipt.source.head` 와 그 항목의 `input_sha` 를
대조했다.

| input_sha | package_root | receipt.source.head |
| --- | --- | --- |
| `eddadc7` | `jarvis-runtime-mqurdy` | `eddadc7` |
| `c2e191a` | `jarvis-runtime-ZbHKKx` | `c2e191a` |
| `ca28dfe` | `jarvis-runtime-eRhLO4` | `ca28dfe` |
| `b6403f7` | `jarvis-runtime-O25Nzv` | `b6403f7` |
| `e3c2f04` | `jarvis-runtime-All4Eo` | `e3c2f04` |
| `0b1c57d` | `jarvis-runtime-5hx5Ww` | `0b1c57d` |
| `8c214c0` | `jarvis-runtime-kEmdpu` | `8c214c0` |
| `e6c63be` | `jarvis-runtime-plP9Mj` | `e6c63be` |

8 항목, **mismatch 0**. 시각은 임의 초를 만들지 않고 관측한 분으로만 적는다
(`observed_finished_at_minute`).

**소유자 급사 경합.** `settleAbandonedPublish` 가 `owned` 를 돌려준 뒤 `assertSwapAdmission` 전에 그 소유자가
죽으면, barrier 는 debris 로 읽히고 정산 없이 `open()` 이 실행됐다. 이제 **소유자를 본 호출은 거기서 끝난다**
(`AUTHORITY_DATABASE_SWAP_IN_PROGRESS`). 그리고 디스크립터가 생긴 뒤에도 phase 기록을 다시 확인해, 여는
도중 나타난 기록이면 디스크립터를 반납한다 — barrier 를 양쪽에서 묻는 것과 같은 이유다.

**변이 검사는 실측대로 적는다.** 디스크립터 이후의 재확인은 **변별된다**(지우면 `expected [Function] to
throw` 로 실패, 복원하면 15/15). `owned` 즉시 거절은 **독립 변별되지 않았다**: 그 교차는 한 호출 내부이고
fault seam 없이 테스트에서 결정적으로 주입할 수 없다. 더 안전하므로 유지하되, 검증됐다고 적지 않는다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `e6c63be77f1b5c5b188cae64270ecf73172633bb` |
| 전체 gate | `VERIFY32=0` (backend 279 / 1,942, dashboard 38 / 263), 관측 종료 13:32 KST |
| 패키지 | `jarvis-runtime-plP9Mj`, `source_head=e6c63be…`, payload 1,544, receipt `a77fa238…`, `integrity=matched`, `deployment_ready=false` |
| manifest | `gate_input_sha=e6c63be…`, 아티팩트 43, 누락 0, package/input 대조 8항목 mismatch 0 |

### 9.37 memory 교체 경로에도 같은 계약을 적용했다 (커밋 `2966c65`)

`memory-authority-swap.ts` 는 관측 뒤 `removeSidecars` 로 WAL/SHM/journal 을 **지우고** live 를 덮어썼다.
`cancellation=false` 면 원본 hardlink 조차 없었다. retention 에서 정한 계약을 그대로 옮겼다.

- 사이드카 삭제 제거. publish **이후** 퇴거된 데이터베이스 이름에 짝지어 옮긴다.
- `cancellation` 여부와 무관하게 퇴거 링크를 먼저 잡는다. cancellation 이 이미 만든 `retiredSourcePath` 가
  있으면 그것을 퇴거 이름으로 쓰고 중복 링크를 만들지 않는다.
- publish 직전 phase 기록 → rename → 사이드카 이동 → phase 종료. 따라서 이 경로의 중단도 열기 전 정산 대상이다.
  phase 기록은 이제 **퇴거된 데이터베이스 경로 자체**를 담아 두 경로가 같은 정산 코드를 쓴다.

**인수는 실재하는 미등록 writer 로 세웠다.** 소스를 쥔 채 WAL 에 커밋한 연결이 있는 상태에서 교체는
`MEMORY_SOURCE_WRITER_ACTIVE` 로 거절되고, live inode·로그·그 행이 모두 그대로 남는 것을 확인한다.

**검증되지 않은 부분을 그대로 적는다.** (a) 마지막 관측 **이후** 연결을 여는 주입은 이 경로에서 성립시키지
못했다 — 훅은 발화했으나 연결 생성이 성립하지 않았고, 성립했다고 주장하지 않는다. (b) 사이드카 퇴거 자체는
현재 memory 스위트로 **변별되지 않는다**: 지우도록 되돌려도 12/12 가 그대로 통과한다. 늦은 writer 가 없으면
그 로그에 잃을 것이 없기 때문이다. 계약은 유지하되 검증됐다고 적지 않는다.

### 9.38 이 시점의 내부 잔여 (최신 코드 기준)

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| 기존 목적지 보존 (P1-C1/C2) | 닫힘 | 목적지를 만들지도 점유하지도 않는다. 세 형태 보존 회귀 green |
| 교체 구간 배타성 — 관측 기반 | 좁힘 | rename 직전 최종 질문. 순간 관측이라는 한계는 §9.32 에 명시 |
| 증명 불가 시 거절 | 적용 | 관측 구멍·외부 쓰기 가능·소유자 외부면 파괴 이전 거절, 기본값 |
| 배제 불가 구간의 보존 | 적용 | retention·memory 모두 퇴거(삭제 아님) + phase 정산 |
| 미등록 연결 표면 | 닫힘(내부) | `src` 의 모든 live open 이 admission 통과, 열거 회귀가 고정 |
| 숨은 같은 UID 프로세스 | 열림 | `/proc` 이 답하지 않는 영역. 교체는 막히지만 배제된 것은 아님 |
| 특권 프로세스 | 열림(명시된 한계) | 사용자 공간 프로토콜로 배제 불가 |
| memory 경로 late-writer 주입 인수 | 미성립 | §9.37 (b). 대체 인수는 거절-보존으로 확보 |
| `owned` 즉시 거절의 변별 | 미확보 | §9.36. fault seam 없이 결정적 주입 불가 |

### 9.39 퇴거에는 수명이 있다 — gate 33 이 잡은 내 계약의 결함 (커밋 `c4ae462`)

`2966c65` 로 memory 경로까지 퇴거를 적용하자 gate 33 이 `VERIFY33=1` 로 떨어졌다. 실패한 것은
`memory-real-process-driver` 의 Task 30 수명주기 인수이고, 이유는 명확하다: **교체된 구세대 데이터베이스가
그대로 남아 있으면, 그 안의 자료도 그대로 남는다.** 민감 자료가 디스크 어디에도 없어야 한다는 인수가 이를
정확히 잡았다. 내 변경이 만든 진짜 결함이며, 테스트를 고칠 일이 아니었다.

퇴거의 **수명**을 정의해 해결했다.

- 퇴거본은 그 inode 에 아직 쓸 수 있는 디스크립터가 있는 동안에만 존재한다. publish 이후 관측에서
  `fd_count === 0` 이면 잃을 것이 없으므로 퇴거본과 그 사이드카를 즉시 제거한다.
- 늦은 writer 가 실제로 잡고 있으면(§9.32 의 인수가 그 경우다) 그대로 남아 커밋이 보존되고, swap 은
  `LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE` 로 보고한다.
- **purge(cancellation)** 은 파기가 목적이므로 로그를 퇴거시키지 않고 제거한다. purge 자신이 만든 퇴거 링크는
  purge 가 소유하므로 이 경로가 손대지 않는다.

retention 82/82, memory cancellation 12/12, Task 30 1/1.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `c4ae462fdcd6b4ca3c53fc23923686265de22172` |
| 전체 gate | `VERIFY34=0` (backend 279 / 1,942, dashboard 38 / 263), 관측 종료 15:12 KST |
| 직전 gate | `VERIFY33=1` — `2966c65` 입력, 위 결함을 잡은 실패이며 테스트가 아니라 계약을 고쳤다 |
| 패키지 | `jarvis-runtime-gIlvC4`, `source_head=c4ae462…`, payload 1,544, receipt `3de0d58a…`, `integrity=matched`, `deployment_ready=false` |
| manifest | 아티팩트 44, 누락 0, package/input 대조 9항목 mismatch 0 |

### 9.40 열한 번째 검토 — 개수는 증거가 아니다 (커밋 `f524ade`, `17b3b74`, `9788997`)

`fd_count === 0` 을 "보존할 것이 없다" 의 근거로 쓴 것이 결함이었다. 마지막 질문 뒤에 commit 하고
**개수를 세기 전에 close** 하는 writer 가 있으면, 그 행은 퇴거된 inode 에만 있고 후보에는 없는데 개수는 0 이다.

**먼저 재현했다.** 창 안에서 열고 쓰고 닫는 연결을 넣자 퇴거본이 삭제되고 그 행이 사라졌다
(`expected [] to have a length of 1`). 기존 인수는 연결을 swap 이 끝날 때까지 열어 두었으므로 이 경우를
지나쳤다 — 지적 그대로다.

**계약을 증거로 바꿨다.** 후보의 내용이 소스에서 분리되는 시점(적용 레코드 직전)에 데이터베이스와 세 사이드카의
(크기, mtime ns) 상태를 기록하고, 퇴거본이 **그 상태 그대로일 때만** 제거한다. `fd_count` 는 필요조건일 뿐
단독 근거가 아니며, 증거가 없으면 남긴다. 변이 검사: 증거 조건을 빼면 그 행이 다시 사라진다.

**purge 도 같은 기준을 받는다.** 늦은 커밋이 감지되면 대상 행과 비대상 행을 그 자리에서 분리할 수 없으므로,
파괴 대신 `MEMORY_PURGE_LATE_COMMIT_UNRESOLVED` 로 거절하고 전부 남긴다.

**그 과정에서 gate 가 두 번 더 잡았고, 둘 다 제품 동작이 아니었다.** `VERIFY35=1` 은 모듈 예산 251/250,
`VERIFY36=1` 은 규칙을 publish 모듈로 옮기며 닫힌 가져오기 순환이다. 전자는 `dropUnchangedRetirement` 로
한곳에 모아 248 로, 후자는 `syncPath` 를 `authority-path-sync.ts` 로 분리해 끊었다(`cycles: []`).

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `97889978c37c2b0360ee83344eebc9f213697dc9` |
| 전체 gate | `VERIFY37=0` (backend 279 / 1,942, dashboard 38 / 263), 관측 종료 16:41 KST |
| 직전 gate | `VERIFY35=1` (모듈 예산), `VERIFY36=1` (가져오기 순환) — 각각 원인과 함께 manifest 에 기록 |
| 회귀 | retention 83/83, memory cancellation 12/12, Task 30 1/1 |
| 패키지 | `jarvis-runtime-SwN3MA`, `source_head=9788997…`, payload 1,545, receipt `0a93c220…`, `integrity=matched`, `deployment_ready=false` |
| manifest | 아티팩트 45, 누락 0, package/input 대조 10쌍 mismatch 0 |

### 9.41 열두 번째 검토 — 기준점의 누락 구간과 읽히지 않는 증거 (커밋 `2f3f198`)

**(1) 기준점이 후보 확정보다 늦었다.** memory 경로는 최종 exclusion 관측 **뒤에** 기준 상태를 잡았다. 관측
직후 commit 하고 close 한 writer 의 행은 후보에 없는데도 기준에 섞여 `before === after` 가 되고, 그 유일한
사본인 퇴거본이 삭제된다. cancellation 이면 비대상 late commit 까지 파기된다.

기준을 **이 프로세스가 더 이상 쓸 수 없게 된 순간**(연결 close 직후)으로 옮겼다. 그 뒤 파일을 바꾸는 것은
전부 타인의 것이고, 어떤 질문 단계에서 열렸다 닫힌 연결의 커밋도 파일 변화로 드러난다. 더해 후보가 확정될
때의 `data_version` 을 `SwapRequest` 로 받아, 그 사이 **다른 연결의 커밋**이 있었으면 파괴 이전에
`MEMORY_SOURCE_CHANGED_BEFORE_SWAP` 으로 거절한다. `data_version` 은 우리 자신의 기록에는 반응하지 않으므로
정상 경로를 막지 않는다 — 처음 시도한 파일 상태 기반 기준은 자기 기록까지 변화로 읽어 모든 cancellation 을
거절했고, 그 실측이 이 구분을 강제했다.

**(2) 읽히지 않는 답을 "같음" 으로 처리했다.** catch-all 이 EACCES/EIO 까지 `absent` 로 만들어, 상태를 읽지
못한 파일이 "변하지 않았다" 와 같은 값이 됐다. 이제 ENOENT 만 `absent` 이고 그 밖의 실패는 `unreadable` 이며,
어느 쪽에든 `unreadable` 이 있으면 같음으로 보지 않는다(단위 회귀로 고정, 디렉터리를 못 읽게 만들어 재현).

변이 검사 둘 다 갈린다: 기준을 다시 늦게 잡으면 그 행이 사라지고, `unreadable` 구분을 빼면 단위 회귀가 실패한다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `2f3f198a90df68d51d46f7a98194ffaf23446153` |
| 전체 gate | `VERIFY39=0` (backend 280 / 1,943, dashboard 38 / 263), 관측 종료 17:52 KST |
| 직전 gate | `VERIFY38=1` — `d7dfd02` 입력, 미사용 테스트 바인딩 1건(제품 결함 아님), 17:25 |
| 패키지 | `jarvis-runtime-Cv4gQt`, `source_head=2f3f198…`, payload 1,546, receipt `efb17228…`, `integrity=matched`, `deployment_ready=false` |
| manifest | 아티팩트 46, 누락 0, package/input 대조 11쌍 mismatch 0 |

### 9.42 두 구간을 나눠서 말한다 — 하나는 닫았고 하나는 남는다 (커밋 `2c1c496`, `5b62a37`)

**구간 A (후보를 읽은 시점 → swap 진입) 는 닫았다.** 후보를 만든 읽기가 본 소스 `data_version` 을
`buildFreshAuthority` 가 **직접 돌려주고**, swap 은 연결이 열려 있는 동안 그 값과 현재 값을 대조해 다르면
파괴 이전에 거절한다. 빌드 종료 후 따로 읽지 않으므로 그 사이에 흡수될 틈이 없다.

**다만 이 수정은 테스트로 변별되지 않았다.** 변이(빌더 값 대신 빌드 직후 별도 읽기)를 넣어도 회귀가 통과한다 —
사용 가능한 주입 지점(`quiesce` 진입)이 두 변이 모두에서 swap 측 대조에 걸리기 때문이고, 진짜 A 구간
(빌드 반환과 바로 다음 줄 사이)에는 주입 지점이 없다. 구성상 틈이 없다는 근거로만 제시하고 증명했다고 적지 않는다.

**구간 B (버전 판독 → close) 는 남는다.** 겹치는 쌍(파일 먼저, 버전 나중)으로 덮으려 했으나 실측이 그것을
부정했다: **우리 자신의 close 가 로그를 데이터베이스로 체크포인트하므로** close 이전 스냅샷은 기준이 될 수
없고(그렇게 두자 모든 cancellation 이 거절됐다), 그 창의 커밋은 우리 close 에 의해 그대로 반영돼 파일 기준과
구분되지 않는다. 관측 위치를 옮겨 없앨 수 있는 문제가 아니므로, 전체 배타성으로 표시하지 않고 남은 구간으로
적는다. 파일 스냅샷은 close 직후에 잡아 그 이후의 모든 변화는 계속 잡아낸다.

**거절 단언은 강화했고 검증됐다.** 오류 코드만으로 통과하지 않는다: 그 행이 live 데이터베이스나 보존된 사본
중 어딘가에서 실제로 읽혀야 한다. "거절했다" 와 "사라졌다" 가 같은 손실에 다른 이름을 붙이는 일은 이제 통과하지
못한다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `5b62a3702df1a2a9423f6d4930d0851294c95fb2` |
| 전체 gate | `VERIFY43=0` (backend 280 / 1,947), 관측 종료 19:04 KST — **단독 수행이 아니었다**, §9.43 참조 |
| 직전 gate | `VERIFY40=1` — fresh builder 251/250 모듈 예산(제품 결함 아님), 18:32 |
| 패키지 | `jarvis-runtime-YSMOF6`, `source_head=5b62a37…`, payload 1,546, receipt `95720871…`, `integrity=matched` |
| manifest | 아티팩트 47, 누락 0, package/input 대조 12쌍 mismatch 0 |

부수적으로, 예산을 맞추려 지운 두 줄이 intent 복사 규칙의 설명이었음을 확인하고 되돌린 뒤 내가 추가한 줄에서
자리를 회수했다. 주석은 예산의 잔돈이 아니다.

### 9.43 검증 기록 정정 — "단독 실행" 은 사실이 아니었다

감시 Codex 의 관측(`monitor-check-20260912T100218745631Z.json`)이 내 기록을 반증했다. 로그로 직접 재확인한
결과는 이렇다.

| run | 입력 | 관측 구간 | RC |
| --- | --- | --- | --- |
| gate40 | `2c1c496` | 18:08:04 – 18:32:29 | 1 (모듈 예산 251/250) |
| gate41 | `5b62a37` | 18:34:57 – 19:03:22 | **없음 — 내 SIGTERM 으로 취소** |
| gate42 | `5b62a37` | 18:35:53 – 19:04:17 | 0 |
| gate43 | `5b62a37` | 18:36:13 – 19:04:37 | 0 |

세 실행은 같은 입력에서 약 **18:36–19:04 동안 동시에** 돌았다. 내가 §9.42 에 적은 "겹친 실행을 정리한 뒤 단독
수행" 은 틀렸다. 정리를 시도한 것은 19:0x 이고, 그때 이미 세 실행이 28분째 병행 중이었다.

**중복이 생긴 경위도 내 쪽이다.** (1) 예산 커밋을 만든 셀이 gate41 을 함께 띄웠다. (2) 내 복원 편집이 그 커밋에
이미 포함돼 있었는데도 입력이 오염됐다고 의심해 gate42 를 띄웠다 — 근거 없는 의심이었다. (3) 정리하려고 보낸
SIGTERM 이 gate41 을 끊고 세션 하나를 함께 내렸으며, 그 직후 "남은 것은 gate43 자신의 자식뿐" 이라고 읽은
것도 오독이었다.

**보존과 판단.** 세 로그를 모두 남기고 manifest 에 세 항목으로 기록했다(gate41 은 `rc: null, cancelled: true`).
제출 근거로는 RC 0 으로 끝난 gate42·gate43 를 쓰되, 병행 구간을 함께 적는다. 부하 병행은 이전 라운드에서
실제로 위양성(gate28)을 만든 적이 있으므로, "동시에 돌았는데 통과했다" 를 "단독으로 통과했다" 와 같은 무게로
적지 않는다. 이 지시에 따라 새 verify 는 시작하지 않았다.

### 9.44 Window A 는 회귀 미비가 아니라 제품 결함이었다 (커밋 `2b63375`)

감시 Codex 가 직접 반례를 만들어 보냈고, 그 반례가 맞다. 빌더는 `data_version` 을 **복사가 끝난 뒤** 읽었다.
그래서 복사 도중 들어온 커밋은 보고값에 이미 반영되고, 후보에는 없다 — 반례의 실측이 원본 2행 / 후보 1행 /
보고 3 이다. swap 은 그 보고값을 현재 값과 비교하므로 "변한 것이 없다" 고 판정하고, 그 행은 퇴거본에만 남았다가
정리 대상이 된다.

**내 이전 진술을 철회한다.** "A 구간에는 주입 지점이 없어 변별할 수 없다" 고 적었으나, `Database.prototype.exec`
를 후킹하면 복사 한가운데에 결정적으로 주입된다. 리포 안 회귀로 옮겼다.

**수정은 두 가지다.** (1) 소스 버전을 **복사 시작 전에** 읽는다. (2) 복사 전체를 한 트랜잭션으로 묶는다 —
이전에는 테이블마다 따로 읽어, 커밋 이전에 복사된 테이블과 이후 테이블이 서로 다른 상태를 보는 구조였다.
두 번째가 없으면 늦은 행이 후보에 부분적으로 섞인다.

**변이 검사 둘 다 갈린다.** 판독을 끝으로 되돌리면 `expected 3 not to be 3` (반례가 잡은 바로 그 등식),
트랜잭션을 빼면 그 행이 후보에 들어와 `expected 1 to be +0` 이다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `2b63375e9cfcde1bfb755be9fda4e02d58781b0e` |
| 전체 gate | `VERIFY44=0`, 관측 종료 21:21 KST — 이번에는 실행 전후로 pid 를 확인해 단독임을 확인했다 |
| 회귀 | 대상 4스위트 11파일 / 100케이스, 전체 backend 280 / 1,943 |
| 패키지 | `jarvis-runtime-fQNXqQ`, payload 1,548, receipt `fac08b61…`, `integrity=matched` |

Window B 는 여전히 열려 있고, 이 수정으로 닫히지 않는다.

### 9.45 Window B 도 닫았다 — 관측이 아니라 잠금으로 (커밋 `0001763`)

**먼저 손실을 재현했다.** swap 이 `data_version` 을 읽은 직후 별도 연결이 commit 하고 close 하면, 교체는
`ok` 로 끝나고 그 행은 **어디에도 없다**. 후보에도, live 에도, 퇴거 사본에도 없다. 지적한 그대로다.

첫 시도는 그 증거가 아니었다는 것도 적는다: 훅이 빌더의 판독에 먼저 걸려 A 경로의 거절
(`MEMORY_SOURCE_CHANGED_BEFORE_SWAP`)로 나타났고 행은 live 에 살아 있었다. **두 번째** 판독으로 옮겨야
B 가 재현된다.

**수정은 잠금이다.** 판독 전에 `BEGIN EXCLUSIVE` 를 잡고 **연결이 닫힐 때까지 유지**한다. 그 사이 다른
연결은 커밋할 수 없으므로, 이미 읽은 버전에는 안 보이면서 close 이후 스냅샷에는 섞이는 커밋이 성립하지
않는다. 트랜잭션은 비어 있어 close 는 쓰기가 아니라 해제로 작동하고, 이미 writer 가 쥐고 있으면 잠금 획득이
실패해 **파괴 이전에** 거절한다. retention 과 memory 양쪽에 같은 형태로 적용했다.

**인수는 손실 금지로 표현했다.** 커밋이 성사됐으면 그 행은 반드시 어딘가에서 읽혀야 하고, 잠금으로 배제됐으면
애초에 존재하지 않아야 한다. 변이 검사: 잠금을 제거하면 `{"committed":true,"outcome":"ok"}` — 커밋이 성사된
뒤 행이 사라져 실패한다.

**통합 실행이 배너 직후 죽던 현상의 원인도 제품이 아니었다.** 이전 라운드의 잔여 프로세스가 누적돼 있었고
(부하 6.15, vitest 12개), 개별 스위트는 모두 통과하며 유휴 상태에서 전체 필터가 통과한다. 이번 gate 는
실행 전에 호스트가 비어 있음을 확인하고 단독으로 돌렸다.

| 이 시점 실측 | 값 |
| --- | --- |
| 제품 SHA | `0001763f71d99acb897bb0b0bbdaf7baa33895d2` |
| 전체 gate | `VERIFY45=0` (backend 280 / 1,943, dashboard 38 / 263), 관측 종료 22:21 KST, 단독 |
| 회귀 | retention 83/83, memory 15/15, 대상 10파일 / 100케이스 |
| 패키지 | `jarvis-runtime-efkBcB`, payload 1,548, receipt `a07f2e77…`, `integrity=matched` |

## 정정 (2026-09-14, unit I4)

위 21행의 "없을 때 `PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED`로 기권하며 **아무것도 쓰지 않는다**"는 부정확했다.
당시의 기권은 `produceDailyRecommendation` 안에서 일어났고, 그 함수는 랭킹 **이전에** 조립한 context를
`personal_context_snapshots`에 저장한다. 따라서 정확한 문장은 "추천은 쓰지 않고 **context만 저장한다**"이다.
이 동작은 의도된 것이다 — 아침 브리핑이 "무엇을 근거로 기권했는지"를 보고할 수 있는 것은 그 context가 남기 때문이다.

측정으로 고정했다: `tests/integration/personal-context-production.test.ts`의 기권 회귀가
`personal_context_snapshots` 1행과 `personal_recommendations` 0행을 함께 단정한다.

현재 제품 경로는 여기서 한 걸음 더 간다. `produceStoredDailyRecommendation`은 근거가 없으면
`produceDailyRecommendation`을 **호출하기 전에** 기권하므로 context조차 남지 않는다.
packaged probe가 이를 실측한다: 기권 세 갈래 모두 `context_rows: 0`, `recommendation_rows: 0`.
