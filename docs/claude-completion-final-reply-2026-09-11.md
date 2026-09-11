# 최종 검증 회신서 — 2026-09-11

## 0. 최종 상태

**`IN_PROGRESS`.**

R2의 두 P1, M2(급사 복구·교체·일정화), M3의 인용 계약, M4.1의 fail-closed refresh adapter,
M5의 설정 manifest·적용/rollback 안은 구현·회귀·전체 gate를 마쳤다. M4.2도 원본 결속과 접수·검토·쓰기·scoped 등록·전송 중
차단까지 구현했다. 백업 복원 재유입 0과 rebuild
동반 제거까지 회귀로 고정했다. 남은 내부 작업은 **이미 저장된 파생 기억의 철회** 하나이며, 그 철회는
소유자 승인 control command와 provider 계약을 함께 요구한다. 2클라이언트 조회 확인도 provider 계약에
달려 있다. 지시서 §11.1에 따라 내부 잔여가 있는 상태를
`READY_FOR_CODEX_FINAL_REVIEW*`로 올리지 않는다.

이 문서는 완료 선언이 아니라, **완료된 부분의 독립 검증에 필요한 전부**와 남은 작업의 정확한 위치를
제출한다.

## 1. 기준 SHA와 트리 실측

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| 제품 검증 SHA (전체 verify 입력) | `45181034055347f9b2512b2e05654b926401056b` |
| 검증 시점 tree | `1be9b34dfa4af79cfa33c49342c866d1f8b5dfa7` |
| 문서 포함 제출 HEAD | 이 회신서를 담은 문서 커밋. `git diff --name-only 4518103..HEAD`가 `docs/`만 보여야 한다 |
| upstream | `not_configured` — ahead/behind 측정 불가 (`git rev-parse --abbrev-ref @{u}` 실패) |
| tracked 변경 | M 0, D 0 |
| untracked | 3 (`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules`) — 도구 상태·공유 의존성, 커밋 대상 아님 |
| 베이스라인 대비 | `082d689..4518103` 39 커밋 (문서 커밋 별도) |
| dashboard 파일 변경 | **0** (`git diff --name-only 082d689..HEAD | grep -ci dashboard`) |

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
보존은 **첫 회차 이후 영구히 실패**한다. `copyFilter`에 `local_retention_claim_intents → "WHERE 0"`를
추가해 닫았다. intent는 이 호스트의 살아 있는 프로세스가 만들려는 디렉터리에 대한 선언이지 데이터가
아니고, 복구는 intent를 live source에서 읽으므로 증거 손실도 없다. 복사 계획을 그대로 재사용하는
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

`tests/integration/local-observation-retention-exclusivity.test.ts` 3건. 모두 **실제 별도 프로세스**를
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


### 9.7 이번 제출의 런타임 패키지 (정본)

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
- **소비도 다시 묻는다.** `candidateTaskSourceClosed()`가 리뷰·표면 권한·provider 쓰기 3지점에서
  "이 후보의 task가 우리에게 닫혀 있는가"를 묻는다. 숨겨졌거나 범위 밖이면 닫힌다. 정책 문서를
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


### 9.10 이번 제출의 전체 gate (정본, 최종)

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

이 라운드에서 실행한 전체 gate는 4회이며 그중 합격 근거로 쓰는 것은 이 1회다.

| 회차 | 입력 | RC | 처리 |
|---|---|---|---|
| 1 | `320b59c` | 1 | 내 변경이 만든 실패 2건. `5a53e10`에서 수정 |
| 2 | `5a53e10` | 0 | 배타성 마감 시점의 합격 (§9.5) |
| 3 | `e2ed929` | 143 | 독립 리뷰가 project-scope 재설계를 요구해 **내가 중단**. 근거 아님 |
| 4 | `f1e6b14` | **0** | **이 제출의 정본** |
