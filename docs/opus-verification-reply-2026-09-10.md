# Opus 검증 회신서 — 2026-09-10

## 판정

**현재 테스트 통과 결과는 확인했다. retention 적용 기능의 인수는 수정 후 재검증이 필요하다.** 새 적용 API를 실제 파일과 격리 DB로 실행한 결과, 원본 경로 별칭에서 파일 삭제, 기존 목적지 덮어쓰기, 선정 이후 추가된 알림의 참조 단절을 재현했다. 읽기 전용 preview의 검증 결과를 적용 API의 안전성 증거로 확장할 수 없다.

이 회신에서는 제품 코드를 수정하지 않았다. 아래 실험은 `/home/jm/.cache/jarvis-opus-review-20260910`에 생성한 전용 임시 DB/파일만 사용했고 종료 시 정리했다. 후속 지시는 `docs/opus-work-instructions-2026-09-10.md`에 있다.

## 검토 대상과 식별

- worktree: `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`
- branch: `codex/routing-approval-ui`
- 검토 시작: `e463c221a61d41983ff328c3296f01b7e2ce3bf5` + tracked 변경 6개, untracked 2개(node_modules 포함).
- 검토 중 Opus의 단위 커밋을 확인했다: `f0d65c6` daily handler 테스트, `97bb2c9` retention 적용/설정, `c5a655b227b2591f14ae4b2abf091591b59322a6` 문서. 이후 상태는 `?? node_modules` 1개였다.
- 빌드 입력 digest: `sha256:63ff4af5aa6ecaa5aa0bf9390cf7243418d18b7e1b00d9c77196a59c2e94a6f3`
- artifact digest: `sha256:a06dc91afcb08f971f54491c770190b6e5a5f17c67580d25a55730beef0ac9a4`
- 현재 입력 및 dist를 다시 해시하여 빌드 metadata의 두 digest와 일치함을 확인했다. input 1,588파일. 전체 verify는 커밋 이전 dirty 입력을 빌드한 실행이며, 새 커밋 SHA에서 다시 실행했다고 표현하지 않는다.

## 전달받은 결과 대조

| 항목 | 직접 확인한 결과 | 한계 |
|---|---|---|
| retention + 기존 timeline CLI | verify5에서 12 + 2 = 14테스트 통과 | 별도 실행의 17.8초는 원본 receipt를 확인하지 못함 |
| 새 daily CLI 테스트 | 3테스트 통과 | src의 execute()를 같은 프로세스에서 호출함 |
| 전체 테스트 | backend 273파일/1,877 + 273파일/1,900, dashboard 38파일/263 | 합계 **584파일/4,040테스트** |
| runtime/lint/architecture/typecheck/build | 로그에서 각 단계 진행 및 후속 단계 진입 확인 | architecture 656모듈/2,438간선/순환 0 |
| acceptance | pre_gjc_ready, stopped, completion_promoted=true, gjc_dispatched=false | 실제 GJC dispatch 증거 아님 |
| CLI smoke | 별도 `node scripts/run-tests.mjs smoke` **exit 0** 직접 확인 | 원래 monitor 종료 코드와 별도 증거 |
| 원래 전체 verify 종료 코드 | 프로세스 종료 확인, **종료 코드 원본 미회수** | mon_TG78CDNX8VJNHHQP 소유 세션에서 최종 결과 저장 필요 |
| retention-preview compiled CLI | 3,600,000ms 창, cutoff 2026-09-10T12:02:20.127Z, 잘못된 두 설정 exit 2 | Opus의 보관 로그/스크립트 대조; 빈 DB 대상 |
| preview DB 불변 | 스크립트가 before/after/final SHA를 비교해 yes 기록 | hash 원문 값은 로그에 없으며, 적용 API나 WAL 동작의 증거 아님 |

`verify5.log`는 과거 동일 이름을 재사용한 파일이다. 이번 실행은 22:02:34 KST에 시작했으며 dashboard는 22:23:57 시작/36.73초 종료가 기록돼 있다. 과거 `run-verify5.sh`는 exit를 로그에 append하지만, 관찰한 실제 실행 명령은 `npm run verify > .../verify5.log 2>&1; echo VERIFY_EXIT=$?`였다. echo는 monitor 출력으로 가므로 해당 로그에는 최종 RC가 없다. 숫자가 더 큰 verify8.log를 이번 실행으로 대체해서는 안 된다.

검토 시점 로그 복사본 `verify5-observed.log` SHA256:
`9df0164c1def10c7434afd8db954d1524c858af822234d5bba9b1cda8a2f1c49`.

## R1 — P1: 적용 목적지 검사가 원본 별칭과 기존 파일을 보호하지 못함

위치: `src/local-observation-retention.ts:153`, `src/memory-authority-fresh-builder.ts:49`.

신규 API는 `freshPath === source.filename` 문자열만 비교한다. builder는 이어서 목적지를 `rmSync(..., {force:true})`로 제거한다.

격리 실측:
- source `/전용임시경로/source.sqlite`, destination `/전용임시경로/./source.sqlite`로 호출하면 문자열 비교를 통과한다.
- 결과: `MEMORY_COMPACTION_ROW_INVALID`로 실패하고 **source_exists_after=false**. 오류 반환이 원본 보존을 보장하지 않았다.
- 별도 실험에서 기존 텍스트 파일을 목적지로 지정하면 오류 없이 DB로 덮어썼다.

판정: 신규 적용 API의 인수 차단 항목. 원본이 운영 DB였다는 뜻은 아니며 이 실험에서는 전용 fixture만 사용했다. 목적지 소유권과 경로 동일성을 보장하기 전 반복 실행이나 운영 적용에 연결하지 않는다.

## R2 — P1: 선정과 복사가 다른 시점의 자료를 사용해 알림 참조가 끊김

위치: `src/local-observation-retention.ts:156`, `src/memory-authority-fresh-builder.ts:52`, `:71`.

selector 뒤 builder의 `await fresh.migrate()`에서 실행이 양보된다. 이 사이 원본에 새 notification이 생겨도 선정 결과는 재계산되지 않는다. 복사는 더 최신 원본에서 수행한다.

실제 compiled 함수 호출 순서:
1. local observation/context/recommendation 체인을 생성한다.
2. `const pending = applyLocalObservationRetention(...)`를 호출한다.
3. await하기 전에 같은 source 연결에서 해당 추천을 가리키는 notification을 저장한다.
4. pending 완료 후 재구축본을 다시 연다.

결과: blocked=3, retained=0, **recommendations=0 / notification_intents=1 / foreign_key_errors=0**, 함수 성공. 원본에는 추천 1개가 남는다. FK가 없는 deep_link 참조는 SQLite FK 검사로 검출되지 않았다.

판정: ‘알림이 가리키는 그룹을 보존한다’는 API 계약이 실제 interleaving에서 깨진다. 일관된 원본 snapshot/쓰기 배제 계약 및 의미상 참조 검증을 갖추기 전 적용 인수 보류.

## R3 — P2: 적용 경로의 ‘원본 무기록’ 주장과 검증 지표가 맞지 않음

위치: `src/local-observation-retention.ts:146`, `src/memory-authority-fresh-builder.ts:44`, `tests/integration/local-observation-retention.test.ts:195` 이후.

builder는 원본에 `wal_checkpoint(TRUNCATE)`를 호출한다. 미반영 WAL이 있는 격리 DB에서:
- WAL 크기 **20,632 → 0 bytes**.
- 원본 DB SHA256 변경.
- 같은 연결의 `total_changes()`는 **105 → 105**.

따라서 total_changes 불변은 이 실험에서 논리 DML 변화가 없다는 지표이며, 물리 파일을 쓰지 않았다는 증거가 아니다. 현재 적용 함수 주석과 두 인계 문서의 ‘원본은 기록하지 않는다’ 문장을 고쳐야 한다. 읽기 전용 preview는 별도 경로다.

## R4 — P2: daily CLI 인수 범위를 실제 프로세스까지 완료했다고 볼 수 없음

위치: `tests/integration/local-observation-daily-cli.test.ts:54`, `:70`, `:87`.

이 테스트는 `execute(f.args, {clock})`로 TypeScript handler를 같은 프로세스에서 호출한다. 동작·replay·hold를 검증하는 유효한 통합 테스트지만, compiled CLI 자식 프로세스의 argv/종료 코드/stdout/stderr/재시작 시험은 아니다. ‘컴파일 daily CLI HOLD 해소’는 이 증거보다 넓은 결론이다.

또한 `tests/fixtures/local-observation-chain.ts`는 context evidence에 linux_live_fact/user_confirmed_principle/owner_decision을 직접 구성한다. 실제 assembler는 context_observation/confirmed_memory를 출력한다. `tests/integration/local-observation-recommendation-lineage.test.ts:92` 이후도 이 구분을 기록한다. fixture 체인의 성공을 실제 assembler→추천 producer 완료로 보고하지 않는다.

## 환경 및 남은 상태 정정

- `/tmp`는 tmpfs/usrquota, 현재 df는 61G 중 49G(81%) 사용으로 원문과 일치했다. 이는 마운트 사용량이며 개별 사용자 quota 잔량을 계산한 값이 아니다. 최초 EDQUOT 자체는 이번 리뷰에서 다시 발생시키지 않았다.
- 실제 backend vitest 프로세스의 TMPDIR/TMP/TEMP는 `/home/jm/.cache/orca-jarvis/tests/run-FNXs8k`였다. runner 코드의 기본 경로와 일치했고 verify5에서 EDQUOT/ENOSPC 문자열은 0개였다. 다른 작업의 산출물은 삭제하지 않았다.
- continuation 문서의 ‘retention 구현 없음’ 행은 현재 구현과 충돌한다. ‘preview 및 fresh candidate 생성 구현, R1/R2 수정·안전한 적용·보존 상한·producer 계약 미완료’로 상태를 정리해야 한다.
- retention 일정화의 개발과 운영 DB 교체 승인은 구분한다. 개발 가능한 계약·구현·격리 시험까지 운영자 결정 대기로 묶지 않는다.
- provider receipt, 외부 입력, 실제 실행자 설정, production 적용 완료를 이번 결과로 선언하지 않는다.

## 증거와 전달 방식

리뷰 QA: `/home/jm/.cache/jarvis-opus-review-20260910`
- `reproduce.mjs`, `reproduce-result.json`: R1/R2/R3 네 가지 실제 compiled 함수 실험.
- `review-before.json`, `review-evidence.json`: 검토 당시 입력 1,878개 hash, 검토 시작부터 22:25:31까지 내용 변경 0개, 로그 digest와 범위.
- `build-identity.json`: 이후 Opus 커밋이 반영된 HEAD에서 입력/dist 동일성 확인.
- `verify5-observed.log`, `cli-smoke.log`: 관찰한 원래 테스트 로그 및 별도 smoke.

이 파일들은 로컬 QA이며 git에 포함되지 않는다. 이 회신은 사용자에게 전달할 문서이며 Opus/Cursor 세션에 메시지를 전송했다는 의미가 아니다.
