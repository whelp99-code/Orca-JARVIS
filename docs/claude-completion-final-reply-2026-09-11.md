# 최종 검증 회신서 — 2026-09-11

## 0. 최종 상태

**`IN_PROGRESS`.**

R2의 두 P1, M2(급사 복구·교체·일정화), M3의 인용 계약, M4.1의 fail-closed refresh adapter,
M5의 설정 manifest·적용/rollback 안은 구현·회귀·전체 gate를 마쳤다. 남은 내부 작업은
**M4.2(task 결과 → 기억 후보의 출처·삭제 전파)** 하나이며, 이는 provider의 lineage 필드 부재와 별개로
JARVIS측 구현이 남아 있다. 지시서 §11.1에 따라 내부 잔여가 있는 상태를
`READY_FOR_CODEX_FINAL_REVIEW*`로 올리지 않는다.

이 문서는 완료 선언이 아니라, **완료된 부분의 독립 검증에 필요한 전부**와 남은 작업의 정확한 위치를
제출한다.

## 1. 기준 SHA와 트리 실측

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| 제품 검증 SHA (전체 verify 입력) | `200f9f7bede300519581e3bd08e7496cf45ed48a` |
| 검증 시점 tree | `e5d7ddaca3a13a4bc4fa894e17920225c543c2c0` |
| 문서 포함 제출 HEAD | 이 회신서를 담은 문서 커밋. `git diff --name-only 200f9f7..HEAD`가 `docs/`만 보여야 한다 |
| upstream | `not_configured` — ahead/behind 측정 불가 (`git rev-parse --abbrev-ref @{u}` 실패) |
| tracked 변경 | M 0, D 0 |
| untracked | 3 (`.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules`) — 도구 상태·공유 의존성, 커밋 대상 아님 |
| 베이스라인 대비 | `082d689..200f9f7` 4 커밋 (문서 커밋 별도) |
| dashboard 파일 변경 | **0** (`git diff --name-only 082d689..HEAD | grep -ci dashboard`) |

packager가 `source_dirty: true`로 기록한 것은 위 untracked 3건 때문이며, tracked 수정은 0이다.

## 2. 커밋 목록과 각 단위의 이유

| SHA | 종류 | 이유 |
|---|---|---|
| `92e2e5a` | 제품+테스트+문서 | R2 P1-A/P1-B 수정. 후보를 복사기 자신의 plan으로 양방향 대조하고, 원본을 snapshot에 고정한 뒤 선정·복사·검증을 모두 그 snapshot에서 수행 |
| `ea4f538` | 제품+migration+테스트+스크립트+문서 | M2. 운영 기록(089)·소유 증명·복구·quiesce 교체·일정 fence(090)·용량 실측 스크립트·운영자 제안서 |
| `0d6d614` | 제품+테스트+문서 | M3 인용 계약. assembler 증거를 출처 기반으로 분류해 advisory 로컬 관측의 승격을 차단 |
| `200f9f7` | 제품+테스트+문서 | M4.1. provider refresh receipt의 fail-closed 파서·버전 협상, `provider_refresh`를 상수에서 저장된 단계 기록으로 전환, provider 인계 bundle |

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
| M4.2 출처·삭제 전파 | **잔여(내부+외부)** | provider lineage 필드 부재(외부) + JARVIS측 차단 전파 미구현(내부) |
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
| run_id | `verify-20260911T023025Z` |
| command / cwd | `npm run verify` / worktree 절대경로 |
| source_head / tree | `200f9f7b…` / `e5d7ddac…` |
| input_digest_before | `sha256:2021c90d0d5084130dbfd5a57fab183cd18870bdafd1491f105aa0ae60602a18` |
| input_digest_after | 동일 (`input_stable=true`) |
| started / finished | `2026-09-11T02:30:25+00:00` → `2026-09-11T02:54:14+00:00` (23분 49초) |
| exit_code / signal | `0` / `null` |
| result_source | direct-process (이 세션이 monitor로 직접 회수) |
| toolchain | node `v24.19.0`, npm `12.0.2`, abi `137` |
| 집계 | backend shard1 278파일/1,908 · shard2 277파일/1,928 · dashboard 38파일/263 = **593파일 / 4,099 테스트** |
| architecture | 664 모듈 / 2,465 간선 / 순환 0 |
| acceptance | `pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false` |
| log | `<QA>/verify-20260911T023025Z/verify.log`, sha256 `cab7cf7bec45a64e103996909a3a940f942b917a4baf385f6e945869660ef736` |

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
| package root | `<QA>/package/jarvis-runtime-6YPDf3` |
| source_head | `200f9f7b…` (`source_dirty=true` — untracked 3건) |
| payload_files / dependency_entries | 1,517 / 6,668 |
| receipt pin (독립 고정) | `7876ec48f6d8da0917ebe1f18e7587dbcdac3e0fdeb269bfc7a68bfc7aafffa7` |
| verify-runtime-package | `ok=true`, `integrity=matched`, RC 0 |
| signature_verified | **false** (운영 서명 없음) |
| runtime_validation | `not_performed` |
| deployment_ready | **false** |
| packaged dashboard HTTP | `/` 200(1,733B), 번들 JS 200(452,054B), CSS 200(26,606B), `/api/v1/health` 200. input digest `sha256:cd84caec…`, 1,610파일 |

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

### 7.2 M4.2 — task 결과 → 기억 후보의 출처·삭제 전파 (**내부 잔여**)

`docs/planning/task-memory-source-privacy-hold.md`의 두 P1이 열려 있다: 수집 전 `task_id` 차단 누락,
수집 후 원본→후보 차단 연결 부재. provider에 `source_lineage`/`task_lineage`/`completion_id` 필드가
없는 것은 외부 사유지만, 수집 전/후·승인 전/후·전송 중·저장 후 차단 전파는 JARVIS측 구현이다.
**이번 작업에서 착수하지 않았다.** 이것이 최종 상태를 `IN_PROGRESS`로 두는 유일한 내부 사유다.

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
   git rev-parse 200f9f7bede300519581e3bd08e7496cf45ed48a
   git status --porcelain
   git diff --name-only 200f9f7..HEAD
   ```
   제품 검증 SHA는 `200f9f7`이고, 마지막 명령이 `docs/`만 보여야 제품 입력 무변경이 성립한다.

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
     tests/integration/second-brain-refresh-receipt.test.ts
   ```
   기대: 전부 통과. 특히 감사 행 손실·값 충돌·ATTACH ABA·선정 외 삭제가 모두 거절되는지.

3. receipt와 입력 readback
   ```bash
   cat /home/jm/.cache/jarvis-m6-20260911/verify-20260911T023025Z/receipt.env
   sha256sum /home/jm/.cache/jarvis-m6-20260911/verify-20260911T023025Z/verify.log
   ```
   기대: `exit_code=0`, before/after digest 동일, log sha256이 §6.1과 일치.

4. 패키지 검증
   ```bash
   node scripts/verify-runtime-package.mjs \
     /home/jm/.cache/jarvis-m6-20260911/package/jarvis-runtime-6YPDf3 \
     --receipt-sha256 7876ec48f6d8da0917ebe1f18e7587dbcdac3e0fdeb269bfc7a68bfc7aafffa7
   ```
   기대: `integrity=matched`, `deployment_ready=false`.

5. 결론: R2/M2/M3 인용 계약/M4.1 adapter의 인수 여부를 판정하고, 남은 M4.2(출처·삭제 전파) 진행과
   §7.1·7.3의 외부 의존성 해소(누가 무엇을 제공할지)를 지시한다.

## 9. 수행하지 않은 행동

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제를 하지 않았다.
운영 서명·notarization·실제 업무 실행·provider 쓰기·외부 전송도 하지 않았다. 독립 리뷰는
`independent_review=not_performed`다. 같은 구현자가 만든 확인을 독립 승인으로 쓰지 않기 위해, 이
회신서는 Codex의 독립 검증을 그대로 요청한다.
