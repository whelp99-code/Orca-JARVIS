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
| 제품 검증 SHA (전체 verify 입력) | `6f88422b1988cb6895477c603cf1b999c2085a90` |
| 검증 시점 tree | `a2327d4fb8d814a7682e2426eb90356ee4d387f3` |
| 문서 포함 제출 HEAD | 이 회신서를 담은 문서 커밋. `git diff --name-only 6f88422..HEAD`가 `docs/`만 보여야 한다 |
| upstream | `not_configured` — ahead/behind 측정 불가 (`git rev-parse --abbrev-ref @{u}` 실패) |
| tracked 변경 | M 0, D 0 |
| untracked | 3 (`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules`) — 도구 상태·공유 의존성, 커밋 대상 아님 |
| 베이스라인 대비 | `082d689..6f88422` 16 커밋 (문서 커밋 별도) |
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
| run_id | `verify-20260911T064437Z` |
| command / cwd | `npm run verify` / worktree 절대경로 |
| source_head / tree | `6f88422b…` / `a2327d4f…` |
| input_digest_before | `sha256:3ab27f7b05f6343b6f77e0a86a4bec7718d9b9b5baba9954d79b3ab1fc57ff30` |
| input_digest_after | 동일 (`input_stable=true`) |
| started / finished | `2026-09-11T06:44:37+00:00` → `2026-09-11T07:08:25+00:00` (23분 48초) |
| exit_code / signal | `0` / `null` |
| result_source | direct-process (이 세션이 monitor로 직접 회수) |
| toolchain | node `v24.19.0`, npm `12.0.2`, abi `137` |
| 집계 | backend shard1 278파일/1,918 · shard2 278파일/1,929 · dashboard 38파일/263 = **594파일 / 4,110 테스트** |
| architecture | 667 모듈 / 2,476 간선 / 순환 0 |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false` |
| log | `<QA>/verify-20260911T064437Z/verify.log`, sha256 `8e131a25be068e9c7e06996ef1c7a49837043527718b507dffb41a0fe48b5513` |

과거 4,066은 목표치로 쓰지 않았다. 위 수치는 이번 실행의 로그 실측이다.

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
| package root | `<QA>/package/jarvis-runtime-jzt1O8` |
| source_head | `6f88422b…` (`source_dirty=true` — untracked 3건) |
| payload_files / dependency_entries | 1,525 / 6,668 |
| receipt pin (독립 고정) | `ca88e28eee929b996ff4968f3cc627a9600ae3df0b8e8767c818723cfeff190d` |
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
   git rev-parse 6f88422b1988cb6895477c603cf1b999c2085a90
   git status --porcelain
   git diff --name-only 6f88422..HEAD
   ```
   제품 검증 SHA는 `6f88422`이고, 마지막 명령이 `docs/`만 보여야 제품 입력 무변경이 성립한다.

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
   cat /home/jm/.cache/jarvis-m6-20260911/verify-20260911T064437Z/receipt.env
   sha256sum /home/jm/.cache/jarvis-m6-20260911/verify-20260911T064437Z/verify.log
   ```
   기대: `exit_code=0`, before/after digest 동일, log sha256이 §6.1과 일치.

4. 패키지 검증
   ```bash
   node scripts/verify-runtime-package.mjs \
     /home/jm/.cache/jarvis-m6-20260911/package/jarvis-runtime-jzt1O8 \
     --receipt-sha256 ca88e28eee929b996ff4968f3cc627a9600ae3df0b8e8767c818723cfeff190d
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

## 9. 수행하지 않은 행동

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제를 하지 않았다.
운영 서명·notarization·실제 업무 실행·provider 쓰기·외부 전송도 하지 않았다. 독립 리뷰는 §8bis대로 **수행했고** 지적 9건을 전부 수정했다. 다만 그 리뷰어는 이 구현을 쓰지 않은
다른 모델일 뿐 운영 승인 권한이 없으므로, 그 APPROVE를 최종 인수로 쓰지 않는다. 이 회신서는 Codex의
독립 검증을 그대로 요청한다.
