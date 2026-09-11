# 최종 검증 회신서 — 2026-09-11

## 0. 최종 상태

**`IN_PROGRESS`.**

R2의 두 P1과 M2(급사 복구·교체·일정화), M3의 인용 계약은 구현·회귀·전체 gate를 마쳤다. 그러나 M4의
JARVIS측 fail-closed refresh adapter와 M5의 설정 manifest·적용안은 **내부 구현이 남아 있다**. 지시서
§11.1에 따라 내부 잔여 작업이 있는 상태를 `READY_FOR_CODEX_FINAL_REVIEW*`로 올리지 않는다. 외부 계약
부재(provider refresh receipt 스키마 미합의)와 내부 미구현(그 부재를 제품 상태로 연결하는 adapter)을
구분해 §7에 각각 기록했다.

이 문서는 완료 선언이 아니라, **완료된 부분의 독립 검증에 필요한 전부**와 남은 작업의 정확한 위치를
제출한다.

## 1. 기준 SHA와 트리 실측

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| 제품 검증 SHA (전체 verify 입력) | `0d6d614d8f56a2e01b5cac67835b85ae1b00e859` |
| 검증 시점 tree | `a7d74eb31fb4c98a103e68db3c201485c5cc5c4a` |
| 문서 포함 제출 HEAD | 이 문서 커밋 이후 값 (§8의 재검증 절차에 기재) |
| upstream | `not_configured` — ahead/behind 측정 불가 (`git rev-parse --abbrev-ref @{u}` 실패) |
| tracked 변경 | M 0, D 0 |
| untracked | 3 (`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules`) — 도구 상태·공유 의존성, 커밋 대상 아님 |
| 베이스라인 대비 | `082d689..HEAD` 3 커밋, 27파일, +1,934 / −224 |

packager가 `source_dirty: true`로 기록한 것은 위 untracked 3건 때문이며, tracked 수정은 0이다.

## 2. 커밋 목록과 각 단위의 이유

| SHA | 종류 | 이유 |
|---|---|---|
| `92e2e5a` | 제품+테스트+문서 | R2 P1-A/P1-B 수정. 후보를 복사기 자신의 plan으로 양방향 대조하고, 원본을 snapshot에 고정한 뒤 선정·복사·검증을 모두 그 snapshot에서 수행 |
| `ea4f538` | 제품+migration+테스트+스크립트+문서 | M2. 운영 기록(089)·소유 증명·복구·quiesce 교체·일정 fence(090)·용량 실측 스크립트·운영자 제안서 |
| `0d6d614` | 제품+테스트+문서 | M3 인용 계약. assembler 증거를 출처 기반으로 분류해 advisory 로컬 관측의 승격을 차단 |

과거 gate 결과를 새 코드에 소급하지 않았다. §6의 전체 verify는 `0d6d614` 입력으로 새로 실행했고, 실행
전후 입력 digest가 동일하다.

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
| M4 provider refresh | **잔여(내부+외부)** | 외부: receipt 스키마 미합의. 내부: fail-closed adapter 미구현 |
| M5 업무 실행 | **잔여(내부+외부)** | 외부: 인증 미설정. 내부: 설정 manifest·적용안 문서 미작성 |
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
| run_id | `verify-20260911T013321Z` |
| command / cwd | `npm run verify` / worktree 절대경로 |
| source_head / tree | `0d6d614d…` / `a7d74eb3…` |
| input_digest_before | `sha256:b6e193081c2d04d189ed61f864299de5e4c14f33f84a7ae30cb77fb40f4aca8c` |
| input_digest_after | 동일 (`input_stable=true`) |
| started / finished | `2026-09-11T01:33:21+00:00` → `2026-09-11T01:56:53+00:00` (23분 32초) |
| exit_code / signal | `0` / `null` |
| result_source | direct-process (이 세션이 monitor로 직접 회수) |
| toolchain | node `v24.19.0`, npm `12.0.2`, abi `137` |
| 집계 | backend shard1 277파일/1,907 · shard2 277파일/1,923 · dashboard 38파일/263 = **592파일 / 4,093 테스트** |
| architecture | 663 모듈 / 2,462 간선 / 순환 0 |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false` |
| log | `<QA>/verify-20260911T013321Z/verify.log`, sha256 `cfcdf1d645e2fe0cb6e79d2b0c84340ac83d3439dbfc18e814644a2089db7a3d` |

과거 4,066은 목표치로 쓰지 않았다. 위 수치는 이번 실행의 로그 실측이다.

### 6.2 최신 런타임 패키지

| 항목 | 값 |
|---|---|
| package root | `<QA>/package/jarvis-runtime-Vde7nJ` |
| source_head | `0d6d614d…` (`source_dirty=true` — untracked 3건) |
| payload_files / dependency_entries | 1,515 / 6,668 |
| receipt pin (독립 고정) | `ca43f053ec5123d6bb6e10e8bd56a0334019be05404d4fde38e343d2de04318a` |
| verify-runtime-package | `ok=true`, `integrity=matched`, RC 0 |
| signature_verified | **false** (운영 서명 없음) |
| runtime_validation | `not_performed` |
| deployment_ready | **false** |
| packaged dashboard HTTP | `/` 200(1,733B), 번들 JS 200(452,054B), CSS 200(26,606B), `/api/v1/health` 200, `/api/v1/session` 200. input digest `sha256:22569854…`, 1,608파일 |

receipt 기대값은 후보 패키지 자신이 아니라 개발 checkout에서 먼저 고정한 뒤 검증기에 전달했다. 패키지
성공은 개발 증거이며 배포 준비 완료가 아니다.

### 6.3 migration 바이트 비교

베이스라인 95개 파일 전부 sha256 **변경 0**, 신규 2개만 추가:
`089_local_retention_operations.sql`, `090_local_retention_cycle_fence.sql`.
벡터는 `<QA>/migration-hash-vector.json`.

### 6.4 원본 쓰기와 checkpoint의 물리 영향

apply가 원본에 남기는 쓰기는 **자기 운영 기록 2행(삽입 1 + 판정 갱신 1)뿐**이다. 실측:
`total_changes` = before+2, 데이터 표 행 수 전부 동일, 원본 main 파일 바이트 불변, WAL만 그 2행만큼
증가, shm 존재. checkpoint는 이제 이 호출이 소유한 snapshot에 적용되므로 원본 main을 건드리지 않는다.

## 7. 외부 blocker와 내부 잔여의 구분

### 7.1 M4 — Second Brain refresh receipt

**외부(계약 부재).** provider측 refresh receipt 스키마와 endpoint가 아직 합의되지 않았다
(`docs/planning/daily-refresh-publication-contract.md:36-37`). `rg`로 refresh 관련 스키마/프로필
버전을 찾으면 매치 0이다.

**설치물은 실재한다(실측).** `/home/jm/.local/state/second-brain/app/current` →
`releases/41f0751aca8906d612961e704bc60dd0855fdabd`, `bin/second-brain-mcp`·`bin/sb` 실행 가능,
`~/.config/second-brain/config.toml` 존재. 기존 scoped read/write/status 계약은 frozen digest까지
갖춰져 있다(`contracts/second-brain-scoped-*.json`, `src/second-brain-scoped-contract-digest.ts:3-9`).

**내부 잔여(이번에 하지 못한 것).** 현재 configured daily는 `src/cli-evening-inputs.ts:34-35`에서
`refresh_reader: { read: () => null }`을 그대로 쓴다. 지시서 §8.4.2가 요구하는 JARVIS측 버전 협상·
파서·fail-closed adapter·제품 상태 연결·계약 회귀는 **미구현**이다. 어댑터가 만족해야 할 타입은
`RefreshCompletionReader` (`src/daily-loop-types.ts:51-53`)이고 성공값은 `RefreshCompletion`
(schema 1, refresh identity, completed/failed, completion 시각, protocol version, cap 플래그,
`src/daily-loop-types.ts:35-42`)이다. null은 `no_data / refresh_missing`이 된다
(`src/daily-loop-time.ts:111-123`).

### 7.2 M4.2 — task 결과 기억 후보의 출처·삭제 전파

`docs/planning/task-memory-source-privacy-hold.md`의 두 P1(수집 전 task_id 차단 누락, 수집 후 원본→
후보 차단 연결 부재)은 그대로 열려 있다. 최신 provider 재확인에서도 `source_lineage`/`task_lineage`/
`completion_id` 필드가 없다(같은 문서 79-86행). 이번 작업에서 이 영역은 건드리지 않았다.

### 7.3 M5 — 업무 실행자

**외부(인증 미설정).** 현재 셸에서 `JARVIS_TASK_CLAUDE_PATH`, `JARVIS_TASK_VERIFIER_KEY_PATH`,
`JARVIS_TASK_VERIFIER_KEY_ID` **3개 모두 미설정**(존재 여부만 확인, 값 미출력). 이 상태에서 실행
경로는 `TASK_EXECUTOR_CONFIGURATION_MISSING`(`src/task-executor-registry.ts:74-80`) →
`TASK_EXECUTION_NOT_CONFIGURED`(`src/task-execution-runtime.ts:24-28`)로 fail-closed다. 등록된
실행자는 `claude-code` 하나이며 codex/cursor는 unsupported로 유지된다.

**내부 잔여.** 승인→dispatch→실행→서명 검증→완료 회귀는 존재하지만 모두 fixture 키·mock provider·
주입 시계다(`tests/fixtures/approved-task-fixture.ts:20-31`, `tests/helpers.ts:15-46`). 지시서
§9.1.4가 요구하는 **설정 manifest·구체적 업무안·적용/rollback 절차 문서**는 작성하지 못했다.

## 8. Codex를 위한 최소 재검증 절차

이미 통과한 전체 gate의 재실행은 요구하지 않는다.

1. checkout 확인
   ```bash
   cd /home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui
   git log --oneline -4
   git rev-parse 0d6d614d8f56a2e01b5cac67835b85ae1b00e859
   git status --porcelain
   ```
   제품 검증 SHA는 `0d6d614`이고, 이 문서 커밋 이후 HEAD는 그보다 앞선다. `git diff --stat 0d6d614..HEAD`
   의 변경이 `docs/`에 한정되는지 확인하면 제품 입력 무변경이 성립한다.

2. 원래 P1 재현과 정식 회귀
   ```bash
   npm run build:backend
   npm run test:integration -- \
     tests/integration/local-observation-retention-plan.test.ts \
     tests/integration/local-observation-retention-consistency.test.ts \
     tests/integration/local-observation-retention-recovery.test.ts \
     tests/integration/local-observation-retention-schedule.test.ts \
     tests/integration/local-observation-retention-source-writes.test.ts \
     tests/integration/local-observation-citation-contract.test.ts
   ```
   기대: 전부 통과. 특히 감사 행 손실·값 충돌·ATTACH ABA·선정 외 삭제가 모두 거절되는지.

3. receipt와 입력 readback
   ```bash
   cat /home/jm/.cache/jarvis-m6-20260911/verify-20260911T013321Z/receipt.env
   sha256sum /home/jm/.cache/jarvis-m6-20260911/verify-20260911T013321Z/verify.log
   ```
   기대: `exit_code=0`, before/after digest 동일, log sha256이 §6.1과 일치.

4. 패키지 검증
   ```bash
   node scripts/verify-runtime-package.mjs \
     /home/jm/.cache/jarvis-m6-20260911/package/jarvis-runtime-Vde7nJ \
     --receipt-sha256 ca43f053ec5123d6bb6e10e8bd56a0334019be05404d4fde38e343d2de04318a
   ```
   기대: `integrity=matched`, `deployment_ready=false`.

5. 결론: R2/M2/M3 인용 계약의 인수 여부를 판정하고, §7의 잔여 3건(M4 adapter, M4.2 출처·삭제 전파,
   M5 적용안)에 대한 진행 승인 여부를 지시한다.

## 9. 수행하지 않은 행동

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제를 하지 않았다.
운영 서명·notarization·실제 업무 실행·provider 쓰기·외부 전송도 하지 않았다. 독립 리뷰는
`independent_review=not_performed`다. 같은 구현자가 만든 확인을 독립 승인으로 쓰지 않기 위해, 이
회신서는 Codex의 독립 검증을 그대로 요청한다.
