# Opus / Cursor 후속 작업 지시서 — 2026-09-10

검증 회신서 `docs/opus-verification-reply-2026-09-10.md`의 R1–R4를 우선 처리한다. 이번 전달 내용은 새 대규모 리팩터 지시가 아니라 retention 적용 결함 수정과 실제 인수 범위 완결을 위한 것이다. 기존 01–25 전체 인계는 `docs/cursor-handoff-2026-09-10.md`를 함께 따른다.

## 0. 시작과 증거 고정

1. `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, branch `codex/routing-approval-ui`에서 AGENTS.md와 적용되는 운영·release 지침을 읽는다.
2. 제품 인계 기준은 `9a9abdf9d9dd0400236b64632fdb5447c433ac86`이며 그 뒤에 이 리뷰 문서 커밋이 있다. `git status`, HEAD, diff를 재확인하고 다른 작업자의 변경을 보존한다. `node_modules`를 커밋하거나 삭제하지 않는다.
3. Opus가 메시지 정정한 `5cd42a5`, `ba1d37e`, `9a9abdf`를 다시 만들거나 중복 커밋하지 않는다. 이전 `f0d65c6`, `97bb2c9`, `c5a655b`와 비교한 최종 tree는 동일하므로 R1–R4는 해소되지 않았다.
4. 후속 보고의 전체 verify exit 0은 접수했다. mon_TG78CDNX8VJNHHQP 소유 세션에 있는 최종 exit code와 종료 시각을 receipt로 보관해 로그와 연결한다. 원본을 회수할 수 없으면 ‘Opus 보고 RC 0 / 리뷰 직접 회수 없음’으로 출처를 구분한다. 프로세스가 사라졌다는 사실만으로 RC 0을 기록하지 않는다.
5. 향후 로그를 재사용하지 않는다. 실행 ID별 로그와 command/cwd/source input digest/시작·종료 시각/RC를 저장한다. 이번 전체 테스트는 584파일/4,040개이며 별도 리뷰 smoke는 RC 0이다.
6. 리뷰 재현을 먼저 읽고 격리 scratch에서 실행한다:

```bash
node /home/jm/.cache/jarvis-opus-review-20260910/reproduce.mjs
```

이 스크립트는 수정 전 결함을 관찰하는 도구다. 정상화 여부를 자동 단정하는 회귀 테스트는 아니므로 R1/R2 기대값을 제품 테스트에 추가한다. 증거가 다른 머신에 없으면 회신서의 호출 순서로 다시 만든다.

## 1. 최우선 수정: 적용 목적지 보호 — R1

대상: `src/local-observation-retention.ts`, `src/memory-authority-fresh-builder.ts` 및 적용/compaction 관련 회귀.

요구 사항:
- 같은 파일의 다른 표기(`./`, `..`, 상대/절대, symlink 경유)를 단순 문자열 비교로 허용하지 않는다. 존재하는 경로는 실제 경로·파일 동일성을 확인한다.
- source와 sidecar, 기존 목적지 및 기존 목적지 sidecar를 훼손하지 않는 목적지 소유권 계약을 정한다. 알려진 다른 호출자의 명시적 덮어쓰기 계약이 있다면 신규 API에 그대로 상속하지 말고 구분한다.
- 목적지는 현재 호출이 새로 확보한 경로만 사용한다. 검사 후 경쟁 상태에서도 기존 파일을 제거하지 않도록 배타적 생성과 builder의 목적지 소유권을 함께 설계한다. 상위의 exists 검사만 추가하고 하위 rmSync를 남기는 것으로 완료하지 않는다.
- 오류 정리는 해당 호출이 소유한 생성물만 대상으로 한다. 원본 별칭이나 타 호출의 파일을 삭제하지 않는다.

필수 인수: 정상 새 경로 성공; 같은 원본/별칭/기존 파일/기존 DB/경쟁 목적지 거절; 각각 source·sidecar·기존 목적지 bytes 보존. 두 호출이 같은 목적지를 경합하는 경우 한 호출만 소유권을 얻어야 한다. 실패 후 원본을 새 연결로 열어 내용까지 확인한다.

공유 builder의 다른 호출자를 먼저 조사한다. shipped migration 수정, 운영 파일로 재현, 광범위 cleanup은 금지한다.

## 2. 최우선 수정: 선정과 복사의 일관성 — R2

대상: selector→builder 연결, snapshot/lease/권한 처리, 의미상 참조 검증.

먼저 어떤 원본을 복사하는지 계약을 정한다. 선택지는 동일한 읽기 snapshot에서 전체 선정을 하고 그 snapshot을 복사하거나, 원본 쓰기를 배제하는 기존 검증된 경계를 끝까지 유지하는 방식이다. async 작업에 SQLite 동기 transaction 콜백을 잘못 씌우지 않는다. 테이블별 복사에서 각각 다른 시점의 원본을 읽는 문제도 함께 처리한다.

필수 요구:
- 선정에 사용한 자료와 복사한 자료가 동일한 일관된 원본에 결속돼야 한다. source digest/generation의 이름만 적고 보장하지 않는 구현은 불충분하다.
- snapshot 후 변경을 허용한다면 fresh candidate는 그 과거 snapshot의 결과임을 명시하고, 실제 교체 전 현재 원본 변경을 감지해 거절/재생성하는 계약을 둔다. 검증 후 변경된 원본 위에 과거 candidate를 덮어쓰지 않는다.
- notification deep_link처럼 FK가 없는 참조도 보존하거나 명시된 정책으로 처리한다. `foreign_key_check=0`만으로 완료 판정하지 않는다.
- 전체 삭제 후보 그룹의 공유 context, replacement 및 보존 그룹과의 연결을 검토해 retained와 blocked가 모순되지 않게 한다.

필수 인수:
1. 선정 뒤 복사 전 새 notification 삽입 — 추천 0/알림 1인 성공 candidate가 나오면 실패.
2. 별도 연결/프로세스가 context·replacement·notification을 추가하는 interleaving.
3. 중간 실패/취소/재시작 — 원본 유지, 미완성 candidate는 적용 불가.
4. 원본이 안정된 정상 경로 — cutoff 경계와 기존 retained 그룹 보존, audit/삭제 계보 유지.
5. candidate 생성 뒤 원본 변경 — 운영 교체 없이 격리 인수에서 stale candidate 감지.

sleep 타이밍에 기대는 flaky 시험 대신 barrier나 제어 가능한 단계로 동시성을 재현한다. 고정 race와 의미상 참조 검사 통과 전 자동 retention 적용을 연결하지 않는다.

## 3. 원본 쓰기 계약 및 문서 정정 — R3

현재 `buildFreshAuthority`의 checkpoint는 DB 파일과 WAL을 바꾼다. 논리 데이터 불변과 물리 bytes 불변을 정확히 구분한다.

- 원본 물리 불변이 요구되는 새로운 계약이면 checkpoint를 원본에 실행하지 않는 안전한 snapshot 경로를 구현한다.
- 기존 maintenance 쓰기가 요구되는 경로는 이를 명시하고 적절한 권한·동시성 조건을 적용한다. 단지 문구를 고쳐서 R1/R2가 해결됐다고 보고하지 않는다.
- 미반영 WAL을 가진 DB로 DML count, logical rows, main DB hash, WAL/SHM의 변화와 reopen 결과를 각각 검증한다. `total_changes()` 하나로 모든 쓰기를 판정하지 않는다.
- `docs/cursor-handoff-continuation-2026-09-10.md`와 `docs/planning/local-timeline-daily-consumption.md`의 ‘원본 무기록’, retention 미구현/구현 충돌, 컴파일 CLI 해소 표현을 최신 계약으로 정리한다.

## 4. daily CLI와 실제 producer 경로 완결 — R4

기존 execute() 통합 테스트 3개는 유지한다. 별도로 실제 `node dist/src/cli.js daily morning --once ...` 자식 프로세스를 실행하는 인수 검증을 추가한다. stdout/stderr, exit code, 재실행 시 저장 ID/행 수, 프로세스 종료 후 새 연결에서 읽은 결과를 기록한다.

- 정책 effective_at 이후 07:15 KST 창을 재현한다. 테스트 전용 격리 clock 주입이나 기존 지원 방법을 사용하고 호스트 OS 시계를 변경하지 않는다. 지원되지 않는 production 우회 옵션을 만들지 않는다.
- 정상 brief, 재실행 무중복, hold 기권, replacement, 만료, 원본 부재, capped를 검증한다. negative_evidence의 FK fixture 구성은 JARVIS가 해결할 테스트 준비 작업이다.
- `provider_refresh=unavailable`, `automatic_operation=hold`를 정상 출력과 함께 정확히 기록한다. daily run completed를 자동 운영 준비 완료로 표시하지 않는다.
- fixture가 context evidence를 수작업으로 만드는 현재 상태를 분명히 둔다. 실제 assembler의 context_observation/confirmed_memory에서 추천이 요구하는 증거로 연결하는 계약을 설계한다. 단순 evidence kind 문자열 치환이나 sufficient 강제 변경으로 연결하지 않는다.
- confirmed principle와 owner decision의 실제 출처·권한 결속이 필요하다. 정확한 local SQLite 사실을 터미널 생존 관측으로 재분류하지 않는다.
- 실제 producer가 context/추천을 만들어 사용하는 acceptance를 통과한 뒤에만 source→brief 운영 경로가 연결됐다고 보고한다.

## 5. 그 다음 작업과 담당 경계

| 순서/담당 | 작업 | 완료 조건 |
|---|---|---|
| JARVIS, R1–R4 후 | opt-in 반복 접수와 retention 일정화 | 저장 증가·알림이 붙잡은 자료·audit 잔존까지 포함한 용량/백로그 정책; 장시간 실패·재시작·중복 기동 인수 |
| JARVIS | 교체 프로토콜의 개발 및 격리 시험 | 원본/candidate identity, writer 배제, 중단 복구, stale candidate 거절이 구현됨 |
| 운영자 | 운영 DB 교체·서비스 재시작·실제 적용 | 검토 가능한 release/rollback/대상/권한을 준비한 뒤 명시적 지시로 적용 |
| Second Brain + JARVIS | refresh receipt 계약 | 최신 provider에서 cap/완전성·release·refresh↔scoped request 매핑 확인; IO 후 fence/활성 generation 재검증 |
| JARVIS + 운영자 | 실행자 준비와 실제 업무 1건 | 대상 환경의 경로/키 준비 후 승인→실행→서명 검증→완료; 개발 셸 설정 판독과 운영 환경을 구분 |

보존 일정이나 budget 기본값은 근거를 갖춘 개발 설정으로 제안하고 격리 검증할 수 있다. 운영자의 적용 승인이 필요하다는 이유로 코드 결함·회귀 시험·계약 설계까지 보류하지 않는다. 별도 사용 허가 없는 외부 메일/메신저 전송, Codex 실행자 지원 선언, 자동 기억 확정은 하지 않는다.

## 6. 검증 및 커밋 기준

관련 테스트를 먼저 수행하고 제품 변경이 통합된 시점에 전체 verify를 1회 수행한다. 같은 입력에 대한 전체 검증의 반복은 새로운 실패·수정·미해결 우려가 있을 때만 한다.

```bash
npm run build:backend
npm run test:integration -- tests/integration/local-observation-retention.test.ts tests/integration/local-observation-daily-cli.test.ts tests/integration/cli-local-timeline.test.ts
npm run typecheck
npm run lint
npm run architecture:check
npm run verify
```

공유 builder 변경 시 `rg`로 실제 사용처와 관련 compaction 테스트를 찾아 추가한다. 위 세 파일만 통과하면 공유 builder 전체가 검증된 것은 아니다. UI 변경이 없으면 새 브라우저 검증을 형식적으로 반복하지 않는다. /tmp 대신 runner 기본 scratch나 명시한 전용 cache를 쓰고 다른 작업의 디렉터리를 지우지 않는다.

커밋 단위는 (1) 목적지 소유권/보호, (2) 일관성·참조 검증, (3) 실제 CLI/producer 연결, (4) 최종 검증 기록을 권장한다. 각 코드 단위에 필요한 회귀를 함께 넣고 기존 커밋을 조용히 수정하지 않는다. 코드 경계상 분리가 불가능하면 하나의 검증 가능한 단위로 묶고 이유를 적는다.

최종 회신에는 각 R1–R4의 해결 SHA·명령/RC·실제 프로세스 여부·관련 테스트 수·예전 재현의 새 결과·남은 한계와 재개 조건을 붙인다. 원래 monitor RC와 수정 후 새 verify RC를 구분한다. 전체01–25 완료나 production 활성화는 별도 증거가 있을 때만 선언한다.
