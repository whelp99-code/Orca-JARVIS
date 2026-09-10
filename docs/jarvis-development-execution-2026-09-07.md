# 자비스 개발 실행 기록

사용자 확정: 기존 개선 목록을 완성 목표로 진행하고, 완료 단위마다 커밋한다.
실사용 검증과 코드/자동 테스트 검증을 구분한다. 문제가 될 기능은 근거와 재개 조건을 남겨 보류한다.
기준 목록은 `improvement-backlog-2026-09-07.md`의 01–25이며 일부 완료를 전체 완료로 보고하지 않는다.

## 전체 명령 목록의 중간 메모리 개선 — 2026-09-10

- backlog16: `listControlCommands`의 전체 원본 행 배열·행 인덱스·필터 배열을
  제거하고, 정렬된 ID 반복자와 기존 트랜잭션 범위 reader를 재사용한다.
  사용처가 없어진 `visibleTaskWorkLineageRows`도 제거했다.
- 기존 배열 반환 계약과 정렬, 조상 격리, 다음 호출의 최신 격리 반영을 유지한다.
  raw row memo는 기존 256행/텍스트1MiB 상한이다. 최종 결과 배열과 boolean
  memo는 전체 건수에 비례하므로 전체 메모리 상한 또는 스트리밍 API라고 주장하지 않는다.
- 관련 통합 테스트4파일7개 통과, 전체 typecheck/backend build/변경3파일 lint exit0.
  기존 조회문 생성 횟수 가정은 공유 조회문1개와 전체 raw 조회0개로 갱신했다.
  부모 에이전트가 diff와 reader의 트랜잭션/정리 경로를 확인했으며 별도 에이전트 리뷰는 없다.
- 실제 빌드의 메모리 SQLite에 10,000건(각 payload4,000문자)을 넣어 조회했다.
  결과10,000건, 처음/마지막 ID 및 총 payload40,000,000문자 확인, DB 쓰기0.
  변경 전 단일 실행: 282.59673ms, heap 증가96,655,112bytes, maxRSS321,440KiB.
  변경 후 단일 실행: 291.073653ms, heap 증가60,999,048bytes, maxRSS244,248KiB.
  단일 실행이며 p95 또는 운영 부하 측정이 아니다. maxRSS에는 DB/fixture 생성도 포함된다.
  메모리 감소와 소폭의 실행시간 증가를 함께 기록한다.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/control-list-` 접두사의
  focused.log, typecheck.log, build.log, memory-baseline.json, memory-product.json.
  product receipt의 mode=baseline은 측정 스크립트에서 실제 제품 함수를 선택하는 인자이며
  수정 전 코드라는 의미가 아니다. 빌드 기준33ca43c+미커밋 변경, input digest
  a260652beb173b6019c6b5b790939fed8afc443c987554bfc74cb1540bdfc62b.
- 아래 전체 gate3985테스트는 이번 변경을 포함하지 않는다. 운영 배포는 하지 않았다.

## 최신 전체 검증 — 2026-09-10 KST, 2807414 기준

- `npm run verify` exit0. Backend269파일1845테스트 +268파일1877테스트,
  dashboard38파일263테스트: 합계575파일3985테스트 통과.
- 런타임 Node24.19.0/ABI137, 전체 lint/typecheck, backend/dashboard build,
  두 backend shard, dashboard, 고정 시계 acceptance 및 CLI smoke 완료.
  Acceptance: pre_gjc_ready / stopped / completion_promoted=true / gjc_dispatched=false.
- 검증 SHA2807414943f2e89de0a6d5957cc9885679210c4d. 실행 전후 추적1857파일
  SHA256 변경0개, HEAD 동일. git status: 미추적 node_modules1개만 존재.
- 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/ 아래
  verify-sse-capacity.log, verify-sse-capacity-before.json, verify-sse-capacity-result.json.
- 이번 gate는 projection key 동시 생성 수정, 실제 TCP 역압 회귀 테스트,
  종료된 SSE 재시도 및 서버당128구독 상한을 포함한다. 앞선 개별 브라우저·소켓
  인수와 함께 해석하며, 전체 운영 배포 또는 backlog01–25 완료를 뜻하지 않는다.

## 이전 전체 검증 — 2026-09-10 KST, 3439aff 기준

- `npm run verify` exit0. Backend267파일/1835테스트 +267파일/1881테스트,
  dashboard37파일/261테스트: 합계571파일/3977테스트 통과.
- Node24.19.0/ABI137 런타임 검사, lint, typecheck, backend/dashboard 빌드,
  고정 시계 acceptance, CLI smoke를 포함한 canonical gate가 종료됐다.
  Acceptance는 pre_gjc_ready / stopped / completion_promoted=true /
  gjc_dispatched=false를 반환했다. 이는 운영 업무 실행 증거가 아니다.
- 검증 SHA3439aff311203e8b12402963889a8e98ea919014. 실행 전후 추적1852파일
  SHA256 변경0개, HEAD 동일. git status는 미추적 node_modules1개만 표시했다.
- 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908 아래
  verify-dashboard-composition.log, verify-dashboard-composition-before.json,
  verify-dashboard-composition-result.json. 결과 관측2026-09-09T19:37:50.778061Z.
- 이 gate에는 실제 production planner 연결과 초기 연결 상태 변경이 포함된다.
  패키지/브라우저 인수는 아래 개별 기록 범위이며 전체 verify가 실제 provider
  작업이나 운영 배포까지 완료했다는 뜻은 아니다. Backlog01–25 잔여와 보류 유지.

## 이전 확인 — 2026-09-10 KST, 0b47991 기준

- 아래 실행 범위 표와 시간순 기록은 당시 증거를 보존한다. 최신 전체 검증은
  ed07b1c의 `npm run verify` exit 0, 569파일/3966테스트, 추적1848파일 해시 변경0개다.
  0b47991의 원문 재사용 상한 후속은 관련5테스트·typecheck/lint/build·컴파일
  1만/10만행 측정·독립 SHIP 리뷰로 확인했으며 전체 검증을 다시 실행하지 않았다.
- 16: generic CLI 기본 목록은 keyset 페이지로 변경됐다. 100건 기본/최대,
  후보500건 검사와 페이지별 현재 차단 재검증을 적용한다. 깊은 공통 연결 표본의
  SQL 호출38503→657, 반환164286바이트/100건, DB 변경0개다. 원문 재사용은
  256행/UTF-8문자열1MiB 상한이며 전체 응답 크기 상한은 아니다. 무제한 library
  list/명시적 --all, 동시 부하 및 전체 응답 크기 계약은 잔여다.
- 25: 명시적인 original/rework/retry의 승인·실행·성과 연결이 구현됐다.
  billing-backed 비용, 외부 효과 중복의 조정된 관측, 실제 실행 결과를 이용한
  후보 정책 비교는 미구현이다. 상세 정본은
  planning/backlog25-remaining-evidence-2026-09-10.md의 최신 절이다.
- 21/24: 현재 개발 셸의 컴파일 CLI에서 등록 실행자1개와 템플릿3개를 확인했다.
  현재 셸에는 실행자·검증 키 설정3개가 없어 runtime probe는 not_probed였다.
  운영 서비스 설정을 검사한 결과가 아니며 이전 격리 실행 인수와 구분한다.
- 22: 제공자79ec701의 기억 저장 요청 파서/모델에서 작업 원본 출처 계약을
  확인하지 못해 자동 수집 보류를 유지한다. 관련 소스2개 미커밋 변경0개,
  재확인 근거는 planning/task-memory-source-privacy-hold.md에 기록했다.
- 01–25 전체 범위, 일일 provider refresh/일반 retention/운영 활성화와 기존
  외부 업무 자동 실행 보류는 그대로 남는다. 이 갱신은 완료 판정이 아니다.

## 실행 범위

### 운영 설정 읽기 및 격리 런타임 패키지 — 4abe9c0

system 범위에는 jm-jarvis 유닛이 없고, `systemctl --user show`에서 서비스와
대시보드는 모두 active/running이었다. 실제 프로세스 환경의 값은 출력하지 않고
설정 존재 여부만 확인했다. 양쪽 모두 JARVIS_TASK_CLAUDE_PATH,
JARVIS_TASK_VERIFIER_KEY_PATH, JARVIS_TASK_VERIFIER_KEY_ID가 없었다.
서비스 cwd는 authority/releases/a3cbbbe1604798052db6051a8751f039573eb126,
대시보드 cwd는 control-center/releases/artifact-4146a192b5fb9e489e2ce3fcb9629077739df0134bc26094750628369dcfdb98였다.
즉 개발 브랜치 검증은 운영 실행자 설정이나 운영 소스 갱신의 증거가 아니다.

`node scripts/package-authority-runtime.mjs --output-parent <QA>` exit0으로
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/jarvis-runtime-GbXulG`를 생성했다.
source HEAD4abe9c0, payload1477파일/9081122바이트, dependency6668항목/44689094바이트.
생산용 의존성 설치·의존성 식별·패키지 CLI smoke·runtime identity가 통과했고,
별도 프로세스의 의존성 재해시도 receipt와 일치했다. source_dirty=true는 그대로
기록하며 당시 git status는 추적 변경0개, 미추적 node_modules1개였다.

runtime-package-receipt.json은 deployment_ready=false를 명시한다. 패키지 자체의
dashboard/provider/reproducibility 검증과 sealed release/활성화 게이트는 미충족이다.
이 산출물을 운영 current에 연결하지 않았다. 서비스 설정 변경·재시작도 수행하지 않았다.

### 실행 준비 오류 안내 보완

실행 환경 확인 화면에서 DB 접근·시간 검사·검증 권한·일반 사전 검사 실패가
모두 조회 재시도 문구로 표시되는 경로를 확인했다. 준비 응답 전용 메시지를
추가해 확인할 운영 항목을 안내한다. 준비 검사의 성공/인증 구분과 기존 실행
오류·승인 거부 판정은 변경하지 않았다.
화면 상호작용 테스트13개, typecheck, 경고0 lint, dashboard build가 통과했다.
처음 typecheck에서 시험용 client의 optional/mock 타입 오류2개를 발견해
테스트 harness가 typed mock을 반환하도록 수정한 후 동일 검사를 통과했다.
검증 범위는 주입한 준비 응답을 사용하는 렌더링 테스트와 빌드다. 운영 API나
실제 장애 유발 인수가 아니며, 기존3966테스트 전체 gate는 이 변경보다 앞선다.
부모가 전체 변경을 확인한 소규모 안내 변경으로 별도 위임 리뷰는 수행하지 않았다.

후속 브라우저 인수: 54442ab에서 `npm run test:e2e` exit 0,
Chromium 1440/1024 두 화면 크기 총28테스트 통과(1.3분).
빌드된 화면과 격리 HTTP/SQLite에서 제안 미리보기의 쓰기 없음, 서명 영수증
검사·승인·실행 정산, 취소·재시도·만료 재계획, 업무 관계 변경 후 재로딩 보존,
접근성 serious/critical 0 및 가로 넘침 없음 시나리오를 검증했다.
준비 오류4종의 원인별 문구는 앞선 주입 응답 화면 시험의 검증 범위이며,
이 브라우저 묶음이 실제 운영 장애4종을 재현했다는 뜻은 아니다.
추적 파일 수정0개; 로그는 공유 QA 경로의 `readiness-browser.log`다.
운영 서비스·실제 모델 호출·배포는 이 실행에 포함되지 않는다.

| 목록 ID | 작업 | 상태 / 완료 증거 |
|---|---|---|
| 선행 수정 | 만료 intent 복구, 단건 명령 조회, 준비 상태 표시, 중복 build 제거 | 독립 리뷰 신규 결함 0; 관련 3파일 9테스트 pass; lint/typecheck/build exit 0 |
| 01 | GJC 오류의 비밀정보 제거 | 구현·독립 리뷰 완료; 자동 32개 및 실제 자식 프로세스 3개 검증 통과; 실제 coordinator 인수는 후속 |
| 02 | runtime 소유권 | 구현·독립 리뷰 완료; 관련 자동 41개와 실제 프로세스/CLI 2개 시나리오 통과 |
| 03 | 만료 정산 | 구현·독립 정적 리뷰 완료; 만료/rollback 10개 및 기존 관련 25개 통과 |
| 04 | 작업 제약·완료 기준을 승인부터 결과까지 보존 | TaskSpec→승인→실제 Claude 후보→독립 verifier→Git 결과→완료 영수증·UI의 격리 인수 완료. 운영 적용은 후속 |
| 05 | 에이전트 연결 상태 | 구조화 관측·120초 TTL·신원 대조 및 live-only 카드 구현. 관련 backend 47개, dashboard 161개 및 실제 Orca→격리 HTTP 검증. 아래 2026-09-08 기록 참조 |
| 06 | 전체 활성 작업 수 집계 | 전역 SQL count·별칭 병합·원본 차단 구현. 21개/20개 페이지 회귀와 실제 1만/10만 건 카드·목록 대조 완료 |
| 08 | 읽기 경로의 초기화 부작용 | 명시적 db rebuild-projections로 분리. pending/failed/rebuilding 조회 쓰기 0, 실제 CLI 후 HTTP 503→200 검증. 아래 2026-09-08 기록 참조 |
| 09 | 만료된 workflow 시작 재시도 | 원래 마감/예산 재검증, 재계획·재승인 안내 구현; HTTP 및 브라우저 검증 완료 |
| 07 | retention 결과 정합성 | 어댑터 미설정 실패, policy 전달, 원자적 처리 구현; 실제 정책별 어댑터·스케줄은 12 후속 |
| 10–11, 21 최소 | 실제 준비 상태와 승인된 작업 한 건의 실행 완결 | Claude CLI·독립 검증·서명·Git·완료 영수증·실제 UI 인수 완료. readiness 인증은 not_probed, Codex 실행자는 unsupported, 운영 대상 등록·인수는 후속 |
| 12 | 일일 스케줄과 실제 retention 어댑터 | 저장 소스 기반 아침·서명된 저녁 단계의 service 연결과 격리 재시작 검증 완료. 기억 후보 정리 스캐너 구현·리뷰 완료(2ba5ddb); 명시적 경로/한도 기반 service 정리 연결·컴파일 CLI 검증·독립 리뷰 완료. provider refresh·일반 retention·운영 적용은 미완료 |
| 13 | 관찰 장애와 실행 장애 분리 | 영속 backoff·건강 상태 및 실제 격리 CLI 검증 완료. 운영 활성화는 후속 |
| 14–19 | 구조·설치·조회·SSE·테스트·운영 정보 | 도메인 일부 분리, Linux 설치/검증 분리, 순차 test shard, SQL/승인 페이지, SSE·HTTP 병합·본문 상한, 빌드 식별 생산자 및 현황판 서버/DB 식별 API·UI 격리 검증. 최신 전체 gate SHAfea01e6: 정리 스캐너·서비스 연결 포함 3881테스트 통과. 구조 부채·일부 목록·별도 daemon/운영 인수는 미완료 |
| 20–25 | 라우팅·실행자·기억 연동·커넥터·템플릿·지표 | 범위 유지; 아래 의존성/보류 항목 참조 |

## 보류 판정과 재개 조건

- 미확정 외부 업무 자동 실행(20/21 확장/23/24의 메일 발신·견적 전달 등): 실행자 계약과 권한·증거 검증이 없는 상태에서는 구현 활성화를 보류한다. 읽기/초안/격리 실행을 먼저 검증하고 실행 범위를 확정하면 재개한다.
- 검증되지 않은 정책의 자동 승격(25): 성공·비용 기준선이 없으므로 보류한다. 먼저 관측과 shadow 비교를 구현하고 증거를 확보한다.
- 세컨드브레인 내부 개편(22의 provider 부분): 별도 작업에서 사용자 지시에 따라 진행한다. 여기서는 자비스 어댑터·영수증·결과 연결과 호환 검증을 담당한다. 인계 문서 참조.
- 운영 활성화: 현재 목표가 개발·실사용 검증을 승인하지만 실제 서비스 교체까지 구체적으로 지정하지 않았다. 격리된 실제 CLI/HTTP 실행을 준비하고, 운영 release 교체는 저장소의 activation gate와 기존 사용자 권한을 확인한다. 운영 미반영을 완료라고 표시하지 않는다.

## 커밋·검증 규칙

- 이 작업 소유의 파일만 명시적으로 stage한다. 기존 AGENTS.md, .cursor, .omo, CLAUDE.md 변경을 섞지 않는다.
- 기능/결함 단위 검증 → 독립 리뷰(중요 변경) → 커밋 → 다음 단위 진행.
- 로그는 `.runtime-tmp/` 등 제외된 경로에 보관하며 추적 문서에는 명령·결과·한계를 기록한다.
- 테스트 수는 실제 출력으로 보고한다. UI/CLI/프로세스 실사용과 가짜 coordinator 테스트를 혼동하지 않는다.
- 최종 전체 gate 및 사용자 동작 기준의 인수 검증이 남으면 목표를 활성 상태로 유지한다.

## 2026-09-07 선행 수정 재검증

- 관련 테스트 3파일 9개 통과. `.runtime-tmp/**`, `.chatgpt2codex/**`, `.omo/**` 제외를 명시했다.
- 최초 명령은 보관된 복사본의 테스트까지 수집했다. 그 결과를 대상 소스의 검증 수로 사용하지 않았다.
- `npm run lint && npm run typecheck && npm run build`: exit 0.
- 독립 리뷰는 기존 diff 범위의 새 필수 수정 0건. ready fixture의 조회 검증이며, 생성자 rebuild 부작용 제거(08)는 아직 미완료다.
- 전체 suite 및 실제 coordinator를 통한 업무 실행 검증은 후속이다. 운영 배포하지 않았다.

## 2026-09-07 P0-01 오류 경계

- 키 이름 정규식으로 임의 오류를 완전히 가릴 수 없어 비정형 stderr와 runner 예외 문구를 외부 오류에 싣지 않는다. 구조화된 고정 오류 코드로 진단한다.
- 알려진 timeout/spawn/output-limit 오류 코드는 보존하며, 알 수 없는 runner 예외는 `GJC_MCP_RUNNER_FAILED`로 제한한다.
- 출력 상한을 nonzero 판정보다 먼저 검사한다. 기존 압축 소스는 동작을 유지하며 읽기 가능한 줄로 펼쳤다.
- 신규 회귀 10개: 수정 전 10 fail → 수정 후 10 pass. 기존 coordinator 2개, reviewability 2개, runtime 18개 통과.
- 실제 Node 자식 프로세스의 stderr 비밀 표식·성공 프로토콜·출력 상한 3개 통과. 이는 실제 GJC/에이전트 업무 인수 검증과 별개다.
- `npm run lint && npm run typecheck && npm run build:backend`: exit 0. 독립 정적 리뷰 필수 지적 0건.

## 2026-09-07 P0-03 만료 정산과 영수증 원자성

- 최초 회귀 5개 중 4개 실패로 만료 시각·만료 후·잘못된 시각·늦은 응답의 완료 수용을 재현했다.
- 저장소가 claimed 상태, fence, 유효한 만료 시각을 확인한다. 서비스는 coordinator 호출 전후 및 최종 기록 시 현재 시각을 확인하고, 오류 정산에도 시작 시각을 재사용하지 않는다.
- 질문 binding, 답변 영수증, 완료 이벤트, 질문 answered 변경을 하나의 SQLite IMMEDIATE 트랜잭션으로 기록한다. 실패를 주입해 부분 완료 기록이 rollback되는지 확인했다.
- 만료 sync는 복구 후 pending, 만료 dispatch/answer는 uncertain으로 남아 자동 재전송되지 않는다.
- 최종 관련 검증: `gjc-settlement-expiry` 10, `gjc-runtime` 18, `gjc-lease-recovery` 5, `task12-runtime-reviewability` 2 — 4파일 35개 pass.
- `npm run typecheck && npm run lint && npm run build:backend`: exit 0. 독립 정적 리뷰 필수 지적 0건, 권고한 rollback 검증 추가.
- 이 검증은 격리 DB와 주입 coordinator 경로다. 실제 에이전트 업무 인수·다중 프로세스 소유권·운영 배포는 아직 완료하지 않았다.

## 2026-09-07 P0-02 실행기 소유권

- owner는 worker 이름·PID·인스턴스 UUID로 구분한다. 유효한 lease는 같은 owner 문자열로도 재claim할 수 없으며 현재 fence를 제시한 heartbeat만 갱신한다.
- 동일 인스턴스의 cycle 중첩과 실행 중 close를 차단한다. 만료 뒤 재획득은 새 fence를 사용한다.
- 단발성 CLI의 `service once`, `service run --once`, `gjc run --once`, `runtime once/batch`는 finally에서 자신의 lease만 해제한다. 후속 owner의 lease는 이전 fence로 해제되지 않는다.
- 실제 Node 프로세스 2개가 같은 WAL DB에 접근하는 시험에서 첫 응답을 IPC barrier로 보류했다. 두 번째 실행기는 leased, claimed intent 1개, 기존 owner/fence 유지. 첫 실행 완료·명시 해제 후 두 번째 실행이 완료되어 completed intent 2개를 확인했다.
- 실제 CLI `service once`를 두 번 실행하여 매번 disconnected 결과와 lease 해제, 서로 다른 owner 및 증가한 fence를 확인했다. 이는 미연결 상태의 CLI 수명주기 검증이며 실제 GJC 업무 완료가 아니다.
- 관련 7파일 42개 통과 후 CLI 실프로세스 시나리오 1개를 추가했고, 실프로세스 파일 최종 2개 통과. 중복 실행을 제외한 시나리오는 총 43개(자동 41개, 실프로세스/CLI 2개)다.
- 최종 `npm run typecheck && npm run lint`: exit 0; 제품 변경 후 `npm run build:backend`: exit 0. 독립 정적 리뷰 새 필수 지적 0건.
- 전체 suite와 실제 업무 입력→승인→실행→검증 인수는 후속이다. 운영 서비스는 교체하지 않았다.

## 2026-09-07 P0-04 작업 명세 보존 — 승인·workflow 구간

- 최초 회귀: 제약 변경, 완료 기준 변경, 해석된 요구사항 누락 3개 실패를 재현했다.
- 제안의 해석된 work type·constraints·completion evidence를 결과와 digest에 포함한다. 직접 입력과 질의 답변이 모순되면 거부한다. 이전 미리보기 digest로 바뀐 요구사항을 제출하면 HTTP 409다.
- TaskSpec v1은 목표·요구사항·팀별 scope/exclusions/verification·예산을 보존한다. TaskSpec digest를 승인 command args에 포함하고 실행 경계에서 objective/members/budget과의 일치를 검사한다.
- 실제 loopback HTTP의 작업 생성→외부 테스트 키로 서명한 승인→workflow start에서 동일 명세가 workflow DB까지 보존됨을 확인했다. 이는 워크플로 시작 검증이며 에이전트 업무 완료가 아니다.
- 대시보드 미리보기에 해석된 제약과 완료 기준을 표시한다. Chromium 1440/1024에서 해당 내용 표시, 미리보기 무저장, pending 작업 생성, serious/critical 접근성 위반 0, 가로 넘침 없음 — 2개 시나리오 통과.
- 브라우저 첫 시도는 기존 4176 리스너와 충돌했다. 별도 포트 55609/39877의 fixture를 사용했다. 다음 시도에서 과거 영문 제목/SSE 라벨 기대를 발견하고 현재 한국어 화면 값으로 E2E helper를 수정했다. 기존 리스너는 종료하지 않았다.
- backend 관련 7파일 50개, dashboard 전체 25파일 136개 통과. `npm run typecheck && npm run lint && npm run build`: exit 0. 독립 정적 리뷰 필수 지적 0건.
- 다음 경계: TaskSpec assignment 구조의 실행 시 검증, 실제 허용 경로·금지 작업 강제, dispatch 및 독립 완료 증거에 동일 digest 연결. Legacy 입력의 읽기/기존 workflow 실행은 유지하며 그 호환성을 새 TaskSpec 실행 보장으로 취급하지 않는다.

## 2026-09-07 P1-07 보존 작업 결과 정합성

- 미등록 adapter의 허위 completed를 재현한 뒤 `failed / E_RETENTION_ADAPTER`로 바꿨다. 실제 등록 adapter의 빈 스캔은 completed와 0개 집계로 구분한다.
- adapter에 job ID·실행 시각·data class·cutoff·policy digest를 전달한다. policy digest는 cutoff까지 포함하는 v2 입력을 해시하며, receipt는 기존 필드 모양을 유지한다.
- retention 실행기별 owner를 구분하고, 실행 전후 현재 owner/fence/만료를 검사한다. SQLite 변경과 완료 정산을 IMMEDIATE 트랜잭션으로 묶고, 예외·오류 집계·정산 실패·처리 중 만료 시 삭제를 rollback한다.
- 독립 리뷰 1건: 쓰기 잠금 대기 동안 만료될 수 있어 transaction 진입 후 시각을 다시 읽도록 수정했다. 재리뷰 미해결 지적 0건.
- retention 10개, composition 1개, reviewability 2개, 기존 jobs/reclaim/expiry 23개 — 중복 제외 관련 36개 통과. 잠금 획득 전후 시각 검증은 주입 clock이며 실제 프로세스 잠금 대기 부하 시험은 아니다.
- export 추가로 발생한 index barrel 252행 gate 실패는 해당 모듈의 public export를 한 re-export로 정리해 250행으로 조치했고 reviewability 2개를 재실행했다. 이 기계적 상한 정책의 개선은 항목14로 유지한다.
- `npm run typecheck && npm run lint && npm run build:backend`: exit 0. 실제 데이터 클래스별 삭제 정책 구현과 일일 운영 연결은 아직 활성화하지 않았다. SQLite 밖 외부 효과를 내는 retention adapter는 이 원자성 계약에 포함되지 않는다.

## 2026-09-07 전체 gate 관측과 동시 변경

- `env TMPDIR=/home/jm/.cache/jvtest DISPLAY=:102 npm run verify`: exit 0. Backend 335파일 1,871개, dashboard 25파일 136개 통과, acceptance와 CLI smoke 완료. Backend 실행 시간 720.63초, dashboard 22.14초.
- 실행 시작 HEAD는 `7b96326`이다. 이번 작업의 제품 수정은 gate 종료 후 적용했다. 실행 중 다른 작업이 `src/second-brain-evidence-parser.ts`, `src/second-brain-read-values.ts`를 수정한 것이 mtime 23:14:18 KST와 diff로 확인됐다. 따라서 위 결과를 `7b96326`의 정확한 단독 소스 검증으로 취급하지 않는다.
- 해당 동시 변경과 이후 추가된 세컨드브레인 어댑터/테스트 변경은 보존하며 이번 재시도 커밋에 포함하지 않는다. 최종 전체 gate는 소스 상태를 고정할 수 있는 시점에 다시 검증한다.
- 실제 `GjcCoordinatorClient` → 설치된 coordinator 호출로 `gjc-coordinator-mcp / 0.11.8`, sessions 3개 응답을 확인했다. 조회 연결 증거이며 실제 업무 dispatch·완료 증거는 아니다.

## 2026-09-07 P1-09 만료 재시도와 재계획 안내

- 회귀 HTTP에서 deadline 시각 및 직후에 만료 workflow가 새 pending 요청으로 생성되는 `202`를 재현했다. 이제 `409 / RETRY_REPLAN_REQUIRED`이며 새 요청·영수증·효과 쓰기 없이 거부한다.
- 읽기 API는 재시도 상태를 제공하고 POST는 현재 clock으로 다시 판정한다. workflow.start의 deadline, 양수 정수 예산, 기존 TaskSpec 바인딩을 확인한다. 유효한 재시도는 기존 args·예산을 그대로 보존하고 새 pending 요청에 별도 승인을 요구한다.
- UI는 재계획이 필요한 작업의 재시도 버튼 대신 기존 `/proposals`로 안내한다. 조회 직후 만료된 경우에도 409 응답을 받아 같은 안내로 전환한다. 구버전 읽기 응답의 optional 필드 부재는 허용하며 서버 검증은 항상 적용한다.
- HTTP 신규 9개: 만료 1ms 전/경계/이후, 조회 후 만료, invalid deadline, steps 0/음수, fractional attempts, attempts 누락. 기존 관련 17개 및 overview/API 6개와 합쳐 32개 통과. null budget은 최초 command stage에서 `CONTROL_ARGS_MISMATCH`로 차단되어 유효한 failed-source fixture가 아니므로 재시도 경계 테스트로 가장하지 않는다.
- dashboard 전체 25파일 139개 통과. Chromium 1440/1024 각각 유효한 재시도와 만료 재계획 동선 — 고유 시나리오 4개 통과. 만료 시나리오는 UI 표시·새 제안 화면 이동·직접 POST 409·SQLite total_changes 불변·serious/critical 접근성 위반 0·가로 넘침 없음을 확인했다. 운영 DB나 실제 에이전트 업무는 실행하지 않았다.
- 새 브라우저 시나리오를 기존 `control-center.spec.ts`에 연결하여 `npm run test:e2e` 및 CI에서 함께 실행한다. 기존 4176 리스너를 보존하고 별도 55609/39877 fixture 및 OS 할당 loopback 포트를 사용했다.
- 독립 정적 리뷰 필수 코드 지적 0건. 추가 예산 검증 권고를 반영했다. `npm run typecheck && npm run lint && npm run build`: exit 0, 테스트/CI 연결 추가 후 typecheck와 lint 재실행 exit 0.
- 이 변경은 기존 개선 항목09의 workflow.start 재시도 경계다. generic workflow dispatch·완료 검증과 실행자 준비 상태(04/10/11/21)는 계속 미완료이며 단순 workflow 시작을 업무 완료로 보고하지 않는다.

## 2026-09-07 P0-04/10/11 선행 — 승인된 GJC 전송 경계

- 설치된 `gjc-coordinator-mcp / 0.11.8`의 `tools/list` 조회에서 `send_prompt` 필수 입력이 session_id/prompt/idempotency_key/allow_mutation임을 확인했다. 기존 durable payload는 권한 메타데이터만 보내 prompt가 없었다. 실제 세션에 send_prompt를 호출하지 않았다.
- 전송 직전에 현재 설정, intent lease, 원문/intent digest, continuation의 scope/budget/fence, census 유효성, 단일 사용 redemption, Ed25519 서명, 승인/키 철회와 만료를 확인한다. 승인된 census의 전체 작업 명세를 prompt 안에 보존하고 MCP 바깥 인수는 공개된 형식으로 제한한다.
- 승인 거부는 외부 호출 0회인 failed로 기록한다. coordinator 호출 이후 응답이 유실되면 uncertain을 유지한다. 같은 continuation의 다른 claimed/accepted/completed/uncertain 또는 receipt가 있는 intent가 있으면 새 CLI idempotency key로도 전송을 허용하지 않는다.
- 독립 리뷰에서 자동 전송 뒤 CLI 새 키로 동일 승인을 재사용할 수 있는 P1 1건을 발견해 수정했다. 재리뷰 필수 지적 0건. 전송 후 failed이면서 receipt도 없는 정산 경로를 추가하지 않는 것이 불변 조건이다. 동시에 두 intent가 claim되면 두 요청 모두 거부될 수 있어 이는 중복 전송 방지와 별도의 가용성 한계다.
- 전송 경계 18개, 기존 runtime 18개, settlement expiry 10개, lease recovery 5개, 실제 CLI 프로세스 2개 — GJC 관련 5파일 53개 통과.
- CLI 검증은 빌드된 `dist/src/cli.js service once`를 별도 Node 프로세스로 실행하고 격리 DB 및 엄격한 로컬 MCP fixture 프로세스를 사용했다. 유효 승인에서는 전송 1회→read_turn→질문 조회→다음 cycle idle, 철회된 승인에서는 coordinator 실행 0회를 확인했다. 두 경우 모두 업무 상태 continued, outbox ACK 0개로, coordinator fixture의 completed를 실제 업무 성공으로 승격하지 않는다.
- 함께 실행한 공통 reviewability는 2개 중 1개 실패: 동시 작업의 `src/second-brain-adapter.ts`가 267 nonblank 행으로 상한 250을 초과했다. 전체 실행 결과는 55개 중 54 pass/1 fail이며 이 실패를 GJC 검증 통과로 덮지 않는다. 해당 어댑터와 generation/read 테스트의 동시 변경을 보존한다.
- 제품 변경 후 `npm run typecheck && npm run lint && npm run build:backend`: exit 0. 테스트 추가 후 typecheck는 통과했고 fixture의 process import 누락으로 lint가 3개 오류를 보고했다. 명시적 `node:process` import 추가 후 `npm run lint`: exit 0.
- 보류/후속: dashboard TaskSpec에는 일반 실행자의 세션·허용 파일 경로를 강제할 계약과 독립 완료 증거 연결이 아직 없다. 자연어 prompt 전달만으로 실행 범위를 강제했다고 주장하지 않는다. 실제 에이전트 파일 변경 1건의 입력→승인→실행→검증 인수와 운영 활성화는 미완료다. 이 선행 수정은 전체 목표04/10/11/21 완료 판정이 아니다.

## 2026-09-07 P0-04/11 — 일반 작업의 기계적 실행계획과 별도 승인

- 정적 설계 검토 결과, 일반 작업은 ControlPlane/ApprovedCommandExecutor/ControlEffectAttempts에 연결한다. recommendation-work의 추천 전용 identity·provider scope·원장에 가짜 추천을 넣는 방식을 보류했다. 설계와 후속 활성화 조건은 `docs/planning/task-execution-contract.md`에 기록했다.
- TaskExecutionPlan v1은 TaskSpec digest, run/task ID, provider, isolated_candidate 모드, 저장소 절대 root/기준 commit, read/write 파일과 기준 digest, network deny, 시간/출력 상한, 검증 argv/cwd/expected_exit를 서명 대상에 포함한다. glob·상위 이동·Git 관리 경로·파일 중복/부모 충돌·무제한 값·예상 밖 필드를 거부한다.
- `control plan-task <plan.json>`은 이미 승인되어 시작된 workflow의 입력/TaskSpec/예산과 대조하고 별도 `task.execute` level 3 pending 요청을 만든다. 이전 workflow.start 승인의 의미를 바꾸지 않는다. 동일 요청 재전송은 total_changes 불변이며 달라진 계획/요청자는 충돌로 거부한다.
- 실행 adapter와 독립 검증이 준비되지 않아 `task.execute`는 executable=false다. 실제 CLI로 계획 생성 시 외부 효과 원장 0개를 확인했다. 승인 후 강제 execute 호출도 failed/APPROVED_ACTION_UNKNOWN이며 외부 효과 0개다. 요청 저장이나 승인 자체를 agent 실행/완료라고 표시하지 않는다.
- 관련 고유 검증: 계획 25개, 기존 TaskSpec 7개, control-action 3개, staging/실제 CLI 8개, 기존 승인 실행기 10개, CLI help 6개 — 6파일 59개 통과. 실제 CLI는 빌드된 Node entry와 격리 SQLite를 사용했으며 실제 agent 호출은 하지 않았다.
- staging 최초 시험 1개는 immutable workflow identity 트리거 때문에 변조 fixture 구성 자체가 거부됐다. 제품 trigger를 완화하지 않고 요청의 다른 task_id 대입 사례로 바꿨으며 해당 파일 최종 8개 통과했다.
- 타입 검사에서 fixture import/리터럴 타입 2개를 수정했고 재실행 통과했다. lint가 제어문자 정규식/불필요 escape 3개를 보고해 문자 코드 검사로 바꿨다. 최종 `npm run lint && npm run build:backend`: exit 0. 독립 구현 리뷰 필수 지적 0건.
- 공통 reviewability는 2개 중 1개 실패: 동시 작업 파일 `src/memory-outbox-store.ts` 266행, `src/second-brain-adapter.ts` 267행이 250행 상한을 초과했다. 이번 소유 변경과 분리해 보존하며 전체 gate 완료를 주장하지 않는다.
- 남은 필수 구현: 실제 repository/commit/파일/symlink preflight, provider 격리 및 준비 상태, 영속 operation binding, 현재 승인 재검증, agent 후보 변경과 독립 verifier, 허용 파일 반영, 증거 없는 LoopGraph 완료 차단, 대시보드 실행계획 동선. 전체04/10/11/21과 나머지 개선 목표는 계속 미완료다.

## 2026-09-08 P0-04/10/11 — 실제 저장소 대조와 후보 입력 사본

- `control check-task`가 workflow 결합을 검사 전후에 확인하고 실제 Git root/HEAD와 선언 파일 digest를 대조한다. metadata/snapshot digest만 반환하며 실행 준비나 성공을 뜻하지 않는 checked 상태와 execution_available=false를 표시한다.
- 입력은 Linux FD-relative/NOFOLLOW로 읽는다. source root 별칭, 부모/파일 symlink, hardlink, 일반 파일 이외 입력, 기존 파일/신규 부재 불일치, 기준 commit/root 변경을 거부한다. 입력 상한은 파일당 4 MiB/전체 16 MiB다.
- 후보 사본은 원본 밖의 private parent에 선언된 입력만 생성한다. 후보와 하위 디렉터리를 FD로 고정하고 exclusive/no-follow 파일 생성으로 기존 파일을 덮어쓰지 않는다. 파일 mode는 OS sandbox를 대체하지 않는다.
- 독립 리뷰 P1 1건: 후보 하위 디렉터리 symlink 교체로 외부 쓰기, 오류 후 후보 이름 교체로 관계없는 디렉터리 재귀 삭제가 가능했다. 회귀 2개를 추가해 모두 실패 재현 후 FD 고정/생성과 실패 후보 보존으로 수정했다. 부모 private 권한 검사도 FD stat으로 옮겼다. 재리뷰 필수 지적 0건.
- 파일시스템 검증 최종 16개 통과. 기존 계획 25개, staging/CLI 8개, help 6개와 합쳐 관련 4파일 55개 통과. 최초 lint의 unused binding 1개는 명시적 metadata 선택으로 수정했다. 최종 `npm run typecheck && npm run lint && npm run build:backend`: exit 0.
- 실제 Git/빌드 CLI smoke는 격리 Git 저장소의 선언 파일 1개·26바이트로 수행했다. 후보 변경 후 원본 동일, 후보 Node syntax exit 0, CLI 검사 전후 SQLite data_version 동일, 이후 원본 변경 시 TASK_REPOSITORY_FILE_CHANGED 거부를 확인했다. 최종 fixture commit은 `6036ecbbe53a2227b98fa2b7a2577d471d5784a7`, 결과는 `.runtime-tmp/task-repository-smoke.json`이다. actual agent 호출 0회이며 실제 업무 완료 증거로 사용하지 않는다.
- 공통 reviewability의 기존 두 memory 모듈 행 수 초과는 별도 실패로 남아 있다. 동시 작업 파일을 덮어쓰거나 이번 커밋에 섞지 않는다. 전체 gate 통과/운영 적용을 주장하지 않는다.
- 남은 필수 구현은 실제 provider OS 격리·인증/준비 상태, 단일 영속 operation binding, 승인된 실행 호출과 현재 권한 확인, 독립 verifier와 원본 반영, 증거 기반 workflow 완료, 대시보드 동선이다. 실패 후보의 안전한 정리도 실행 원장과 연계해야 한다. `task.execute`는 계속 비활성 상태이며 전체 목표를 유지한다.

## 2026-09-08 P0-04/11 — 요청을 넘는 실행 시도 결합

- 입력 검사/후보 사본 단위는 `5b127b0`으로 커밋했다. 재개 시 파일시스템 16개를 재실행해 통과했다. 이전 인계 턴에서는 인계 문서 갱신과 앱 전달 실패 증거를 기록했고, 이번 턴은 자비스 개발을 재개했다.
- 새 migration 058은 기존 외부 효과 원장에 run/plan digest와 unique index를 추가한다. 별도 큐나 추천 전용 테이블을 만들지 않는다. prepareTask와 beginTaskInvocation은 IMMEDIATE 트랜잭션 안에서 현재 시각, 원본 요청·인수·digest, 서명·decision key·철회, claim/redemption/fence와 만료, workflow/TaskSpec/예산을 검사한다.
- prepared→invoking은 한 번만 가능하다. 같은 plan의 새 서명 요청도 기존 operation이 있으면 거부한다. 만료 뒤에도 uncertain 기록은 가능하며 일반 외부 효과 update로 task를 confirmed 처리할 수 없다. 승인 상태만 위조하고 서명 바이트를 재사용한 DB fixture도 효과 0개로 거부했다.
- 독립 리뷰 P1: INSERT OR REPLACE의 동일/새 요청 우회를 회귀 2개로 실패 재현했다. 보강 후 rowid non-task 교체 우회 1개를 추가로 재현했다. INSERT 충돌과 UPDATE rowid/별칭 충돌을 trigger에서 차단했고 최종 재리뷰 추가 필수 지적 0건이다.
- 최종 task 원장 18개와 실제 프로세스 1개 통과. 관련 migration 7개, runbook 5개, staging/CLI 8개, memory HTTP 7개, migration compatibility 1개를 합쳐 중복 제외 7파일 47개 통과했다. 최초 키 철회 fixture의 잘못된 revoked_at 컬럼은 실제 created_at으로 수정했다.
- 실제 Node 자식 프로세스 2개가 같은 WAL DB에서 서로 다른 승인 요청으로 경쟁하여 invoking 1개/rejected 1개를 확인했다. 두 프로세스를 SIGKILL한 뒤 DB를 다시 열어 세 번째 승인 요청도 거부되며 원장 1개가 유지됨을 확인했다. 실제 agent 호출은 0회다.
- 최종 제품 변경 후 typecheck/lint/build:backend exit 0. 공통 reviewability는 2개 중 1개 실패했다: 병행 작업의 index.ts 252 nonblank, memory-outbox-store.ts 270 nonblank, memory-remember-artifact.ts 최대 줄 길이 202, second-brain-adapter.ts 267 nonblank. 이 관측의 다른 작업 변경은 이번 커밋에 포함하지 않는다.
- 보류/후속: 원장만으로 provider를 활성화하지 않는다. prepared 중단의 안전한 재개, invoking 종료의 조정, OS 격리·인증, 실제 agent 실행, 독립 검증·원본 반영, workflow 완료 증거와 UI 동선은 계속 미완료다. task.execute는 executable=false이고 전체 01–25 목표와 실사용 인수는 유지한다. 운영 migration/서비스 교체는 수행하지 않았다.

## 2026-09-08 P0-10/11 — 실제 Linux 후보 검증 명령

- 이전 목표 턴은 입력 검사·영속 operation 구현 커밋으로 진행했다. 이번 재개에서 HEAD/dirty 상태를 확인하고 실제 provider/검증 격리 경로를 조사했다. `codex exec --help`, `claude --help`, `bwrap --help`를 확인했다. 예전 형식의 `codex sandbox linux --help`는 exit 101이었고 현재 `codex sandbox --help`에서 linux 하위 명령이 없는 형식을 확인했다. 실제 provider 호출은 하지 않았다.
- 설치된 bubblewrap 0.11.1의 namespace 실행 `/bin/true`는 exit 0이었다. 새 검증기는 읽기 전용 런타임과 후보 바이트의 ro-bind-data 사본만 제공하며 네트워크/홈/호스트 작업공간/인증·DB 접근을 분리한다. 후보 입력 집합/read digest를 검사하고 각 명령에 별도 Buffer를 전달한다. 결과에 plan/candidate digest와 exit/stdout/stderr digest·바이트 수를 결합한다.
- 모든 명령에 시간·stdout+stderr 합산 출력 예산을 적용한다. 늦은 성공·음수/비정상 결과·과도한 출력을 거부하며 runner의 임의 오류 문구는 고정 코드로 바꾼다. checks_passed는 해당 후보의 명령 결과이고 서명된 작업 완료가 아니다.
- 자동 검증은 새 후보 검증 13개, 기존 계획 25개, 파일시스템 16개 — 중복 제외 3파일 54개 통과. 최초 typecheck는 readonly fixture 변경 6개 오류였으며 새 mutable 사본을 구성해 수정했다. 최종 typecheck/lint exit 0, 제품 변경 후 build:backend exit 0. 독립 정적 리뷰 필수 지적 0건이다.
- 실제 첫 후보 실행에서 TASK_SANDBOX_INPUT_FAILED를 관측했다. 합성 입력으로 stderr를 별도 조사해 `--disable-userns requires --unshare-user`를 확인하고 명시적 --unshare-user를 추가했다. 다음 smoke는 합성 argv 안의 줄바꿈을 계획 계약이 거부했다. 같은 코드를 한 줄 argv로 바꿨으며 계획 검증은 완화하지 않았다.
- 최종 실제 smoke 6개: 정상 Node syntax, 중첩 두 파일·상대 cwd 검증, syntax 실패 exit 1, 호스트 sentinel/proc/env/loopback 접근 및 workspace 변경 차단, 1초 timeout, 출력 상한. 6개 모두 예상 결과와 일치했다. 별도 detached 손자 시험은 stdio 닫기·세션 분리 후 실제 1개를 /proc에서 확인했고, timeout 뒤 Z를 관측했다. 실행 종료 증거이며 즉시 reap 완료는 아니다. 결과는 `.runtime-tmp/task-sandbox-smoke.json`, `.runtime-tmp/task-sandbox-descendant-smoke.json`이다. 고유 실제 시나리오 7개, agent 호출 0회다.
- 병행 작업 커밋 c7c5182 이후 공통 reviewability 재실행은 2개 중 1개 실패: index.ts 252 nonblank, memory-outbox-store.ts 270 nonblank, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 274 nonblank. 해당 memory 코드 변경은 이번 작업에 섞지 않았다. 전체 gate나 운영 적용 완료를 주장하지 않는다.
- 남은 경계: provider 인증·통신·도구 격리, 승인 재검증과 실제 호출 연결, 후보 파일 수집과 독립 verifier 신원/서명, 원본 반영·workflow 완료, UI 동선. 호스트에서 종료된 자손의 회수 및 배포 런타임 준비 상태도 운영 연결 시 검증한다. task.execute는 비활성이며 전체 01–25 목표를 계속 유지한다.

## 2026-09-08 P0-04/10/11 — 실제 Claude 후보 생성과 승인된 검증 연결

- 직전 인계 응답은 기존 문서·대상 task 재확인으로 자비스 제품 변경은 없었다. 이번 재개에서 진행 중이던 테스트 handle을 확인해 10개 통과/exit 0을 회수하고, 실제 후보 실행 연결 개발을 진행했다. 병행 memory 작업은 a680fd5로 커밋됐으며 그 변경은 이번 단위에 포함하지 않는다.
- `executeTaskCandidate`는 현재 서명·claim·workflow 권한, 실제 Git/파일 입력, 전체 TaskSpec을 확인한 뒤 기존 외부 효과 원장으로 1회 호출을 결합한다. Claude CLI는 도구/MCP/slash command를 비활성화하고 exact write 경로와 계획 digest를 구조화 응답에 요구한다. 원본 read 파일은 신뢰된 사본에서 유지하고 출력 이후 실제 원본을 재검사한 다음 bwrap 검증을 수행한다.
- 독립 리뷰 P1 1건: 호출 예약 뒤 realpath/stat/open을 기다리는 동안 승인이 만료·취소돼도 subprocess가 시작될 수 있었다. provider와 verifier의 실제 spawn 직전에 동기 승인/마감 검사를 추가하고 준비 시간도 차감했다. 입력 캡처·문맥 준비 후 실행 단계에는 monotonic 마감도 추가해 wall clock 변화가 예산을 늘리지 못하게 했다. 최초 입력 준비는 이 공유 마감에 포함되지 않는다. 비동기 준비 중 취소 및 마감 초과는 spawn 0회, verifier FD close 1회를 검사한다.
- 최종 자동 검증은 provider 계약 12개, 승인된 후보 실행 15개, subprocess 경계 5개, 기존 후보 검증 13개 — 4파일 45개 통과. 타입 검사·lint·build:backend exit 0. 최초 lint의 미사용 test 인수 1개는 callback 실행으로 수정했다. 독립 재리뷰에서 기존 P1 수정 및 추가 필수 코드 지적 0건을 확인했다. 마지막 문서 리뷰의 마감 시작점·workflow 상태 보존 표현 2곳도 실제 동작에 맞춰 좁혔다.
- 실제 Claude 선행 probe 1회는 exit 0이었으나 절대 경로 응답을 반환했다. 제품 스키마에 허용된 상대 경로 enum을 추가하고 별도 출력 검증을 적용했다. 이후 signed fixture→실제 Claude→실제 bwrap smoke를 2회 수행했다. 두 번째는 monotonic 전체 마감 추가 후 최종 빌드 확인이며 새 Git/DB/승인으로 실행했다. 같은 승인을 재전송하지 않았다. 누적 실제 provider 호출은 선행 probe 포함 3회다.
- 최종 실사용 smoke(2026-09-08 01:10:13 KST)는 actual provider 호출 1회, Node 문법/answer=42 값 검사 각 exit 0, read 입력 유지, 원본 answer=41 유지, 새 승인으로 같은 계획 재호출 거부를 확인했다. Git 기준은 `579c5ef2bf7fe84864246b9e88705e7e5eca0fb8`, candidate digest는 `sha256:836d0ba785e070d57d4a1be7d3052652450f2858e214eeeb58ee2196b9874941`이다. 결과는 `.runtime-tmp/task-candidate-live-smoke.json`이며 합성 입력/격리 DB를 사용했다. 운영 DB/서비스 변경은 하지 않았다.
- 공통 reviewability는 2개 중 1개 실패: index.ts 253 nonblank, memory-outbox-store.ts 270 nonblank, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 274 nonblank. 최초 잘못된 `tests/unit/reviewability.test.ts` 경로는 테스트 0개/exit 1이었고 실제 `tests/integration/task12-runtime-reviewability.test.ts`로 재실행한 결과다. 전체 gate 통과를 주장하지 않는다.
- 보류/후속: task.execute 운영 활성화, Codex provider, 후보 영속 artifact/복구, 독립 verifier 서명, 허용 파일 반영과 workflow 완료, 대시보드 동선은 미완료다. 현재 성공은 candidate_checked/published=false, 원장 invoking/요청 claimed/workflow running이며 이 측정을 업무 완료로 승격하지 않는다. 도구 없는 Claude 추론은 설치 CLI와 인증을 신뢰하며 provider 본체 OS 격리나 managed hook의 전환경 차단을 보장하지 않는다. 전체 01–25 목표는 유지한다.

## 2026-09-08 P0-11 — 후보 영속 저장과 중단 후 회수

- 이전 목표 턴은 실제 Claude 후보 실행 단위를 b50684d로 커밋한 진행 턴이다. 이번 재개에서 현재 소스/원장을 읽고 메모리에만 남던 후보를 operation별 SQLite artifact로 연결했다. 별도 실행 큐나 파일 저장 서비스를 추가하지 않았다.
- 새 migration 059는 attempt_id PK/FK와 WITHOUT ROWID 테이블 1개를 추가한다. 후보 내용/identity의 UPDATE·DELETE·REPLACE를 차단하고 검증 JSON/digest/기록 시각만 NULL에서 한 번 기록한다. migration 058과 이전 SQL 바이트는 수정하지 않았다. 059 SHA-256은 `ffe66538d59f89fd59d538e24bac442ced17d17f979875b1822423eb31a487fe`이며 회귀 검사에 고정했다.
- provider 출력 검사 뒤 verifier 실행 전에 현재 서명·receipt·fence·run/plan·invoking 상태를 확인해 후보를 COMMIT한다. 검증 기록도 현재 권한과 후보/계획 결합을 확인하며, transaction 안 read-back 이후 마지막 권한·마감 재검사에서 만료되면 rollback한다. exact 재저장은 total_changes 불변이고 다른 내용/측정은 충돌이다.
- 회수는 읽기 전용이다. SQL에서 payload 24 MiB·측정 256 KiB·계획 4 MiB 상한을 적용한 뒤 정규 base64·디코딩 4 MiB/파일 및 16 MiB/전체·read digest·원본 manifest·후보/계획/payload digest를 재검사한다. source snapshot 재계산은 로컬 관측 metadata의 일관성 검사이며 외부 서명된 원본 증거가 아니다. local measurement도 독립 verifier 서명이나 완료 권한이 아니다.
- 독립 리뷰 P2 1건: 검증 JSON 32 KiB 제한은 허용된 128개 긴 경로를 수용하지 못했다. schema·쓰기·읽기를 256 KiB로 맞추고 128개 긴 경로 회귀를 추가했다. partial PASS 거부/실패 prefix 허용, 저장·검증 COMMIT 직전 만료 rollback도 확인했다. 재리뷰 추가 필수 지적 0건이다.
- 최종 관련 검증: 후보 저장 21개, 후보 실행 16개, migration 7개, 기존 verifier 13개, 실제 process 3개 — 5파일 60개 통과. 타입 검사·lint·build:backend exit 0. 최초 migration 순서 기대값의 059 누락 1건과 MJS fixture의 Buffer import 누락 1건은 수정했다. 실행 중 병행 memory-outbox-control.ts의 구문 오류로 typecheck 및 4 suite 수집이 실패한 회차는 테스트 0개였다. 해당 파일이 병행 작업에서 수정된 것을 읽고 재실행했으며 우리 변경에 포함하지 않는다.
- 실제 Node 자식 프로세스 3개 시나리오 통과: COMMIT 뒤 SIGKILL은 후보 회수/측정 없음, 열린 transaction의 COMMIT 전 SIGKILL은 후보 0개, 서로 다른 후보를 두 프로세스가 동시에 저장하면 saved 1개/conflict 1개다. 어느 중단 지점에서도 기존 invoking이 유지되어 provider 재예약을 거부한다. 이는 프로세스 종료/WAL 복구 시험이며 전원 장애 시험은 아니다.
- 실제 Claude→영속 후보→bwrap 검사→측정 저장→별도 DB 연결 회수 smoke도 provider 호출 1회로 통과했다(2026-09-08 01:28:03 KST). 문법과 answer=42 검사는 각각 exit 0, 원본 answer=41 유지, 동일 계획 재호출 차단을 확인했다. artifact는 `task-candidate:f226c6b79ee65766288f821ae07f3bd5d048c23ff021a30eaabaf5da38257540`, 결과는 `.runtime-tmp/task-candidate-live-smoke.json`이다. 합성 저장소/서명 fixture DB를 사용했고 운영 DB/서비스는 변경하지 않았다.
- 공통 reviewability는 2개 중 1개 실패: control-plane.ts 265 nonblank, index.ts 253 nonblank, memory-outbox-store.ts 270 nonblank, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 274 nonblank. 이들 병행 변경을 이번 단위에 섞지 않았으며 전체 gate 완료를 주장하지 않는다.
- 남은 경계: 모델 응답과 후보 COMMIT 사이 종료되면 후보가 없을 수 있다. artifact COMMIT 이후부터 회수를 보장하며 자동 provider 재전송은 금지한다. 검증 재개/최종 정산, 독립 verifier 서명, 원본 반영, Codex provider/준비 상태, UI 동선과 저장 보존·용량 정책은 미완료다. task.execute 운영 활성화는 보류이고 전체 01–25 목표를 계속 유지한다.


## 2026-09-08 P0-04/11 — 독립 프로세스의 서명된 후보 검증

- 직전 인계 확인 턴은 개발 상태 변경이 없어 no progress로 분류했다. 이번 턴은 현재 main과 병행 memory 변경을 확인한 뒤 미완료 clock/독립 검증 구현을 이어갔다. 전체 개선 01–25와 최종 실사용 인수 범위는 유지한다.
- Migration 061은 prepared→invoking 시 Linux boot UUID·time namespace·uptime 마감을 기존 operation에 한 번만 기록한다. 다른 프로세스도 동일 마감만 소비하며 부팅/namespace 변경과 deadline 없는 과거 operation을 거부한다. wall clock 역행과 정밀도 손실로 예산을 늘리지 않는다. 기존 060 이하 migration 바이트는 수정하지 않았다.
- Migration 062는 artifact별 검증 예약, 1회 invocation CAS, immutable proof를 기록한다. 별도 Node entry가 저장 후보를 읽고 현재 승인·receipt·fence·workflow·TaskSpec을 확인한 뒤 실제 bwrap 검사를 수행한다. Ed25519 서명에는 계획/후보/payload/예약/invocation/시간/키/측정이 결합된다. decision 공개키와 DER 바이트가 같은 verifier 키를 거부한다.
- 저장·소비 시 현재 권한, 키 및 검증 참조 철회, 남은 시간/출력 예산과 측정 내용을 재검증한다. 잘못된 서명/domain/키/nonce/후보/receipt/fence/task, 불완전 PASS와 미래 시각은 거부한다. signed checks_failed도 recorded로 보존하며 업무 성공으로 승격하지 않는다. COMMIT 직전 lease 만료 시 proof 기록을 롤백한다.
- 실제 Node 프로세스 2개가 검증 시작을 경쟁하여 running 1개/rejected 1개였다. SIGKILL 후 재개는 거부됐고 동일 clock_id/deadline과 기존 invocation이 유지됐다. 실제 verifier entry의 공개 읽기 가능한 키·symlink·다른 private key·추가 입력 필드 거부도 4개 시나리오로 확인했다.
- 관련 고유 테스트 최종 11파일 110개 통과: certification 26, certification process 1, verifier entry 4, execution clock 8, operation 18, operation process 1, process boundary 5, candidate artifact 21, candidate execution 16, migrations 7, artifact process 3. 최초 certification 실패 7개는 잘못된 fixture 컬럼, sealed anchor 변경과 trigger 오류 메시지 순서 가정이었다. 실제 스키마를 사용하고, 키 중복 검사는 fixture에서 sealed-update trigger를 제거해 잘못 구성된 anchor를 명시적으로 재현했다. 제품의 기존 sealed trigger는 변경하지 않았다.
- 실사용 경로 시험 2026-09-08 01:57:05 KST: 실제 Claude CLI 호출 1회, 격리 Git의 answer 41→42 후보 생성, 기존 로컬 검사 2개와 별도 Node verifier의 bwrap 검사 2개 모두 exit 0, Ed25519 서명 검증 통과, 두 번째 verifier entry는 TASK_CERTIFICATION_INVOCATION_CONFLICT로 종료했다. 원본은 41 그대로이며 read 파일 변경 0개, published=false, operation invoking/request claimed/workflow running을 확인했다.
- 실측 artifact는 `task-candidate:fce38be8611015179e07192c2c745593ee8b343135c181400e7d0e9918e9d3e3`, candidate digest는 `sha256:e106d2f57f83e24503b11099baf38259d08f53a1743b1f92418f2c3f2a7cf651`, verifier invocation은 `420788b7-d214-46ce-97c4-1e5c62a2e0df`다. 원본 commit은 `c9b513c8ad667330b44b73d7aa60a2ff81955f4a`, 상세 로컬 증거는 `.runtime-tmp/task-certification-live-smoke.json`이다. 운영 키가 아닌 격리 fixture 키/DB를 사용했으며 fixture는 종료 후 삭제했다.
- 독립 정적 리뷰 최종 필수 지적 0건. typecheck/lint/build:backend exit 0. 공통 reviewability는 2개 중 1개 실패: control-plane.ts 265 nonblank, index.ts 255, memory-outbox-store.ts 270, memory-remember-artifact.ts 최대 줄 길이 202, second-brain-adapter.ts 278. 이들은 해당 관측 시점의 기존/병행 변경이며 이번 신규 모듈의 상한 초과는 0개다. 전체 verify 통과를 주장하지 않는다.
- 남은 필수 구현: 신뢰 verifier를 실행·수집하는 부모 adapter, 검증/취소 중단 후 운영 복구, 허용 파일 원본 반영과 실패 복구, 증거에 따른 workflow 정산, UI 실행 동선, Codex provider와 준비 상태. 키 파일 검사는 별도 OS UID 격리가 아니며 호스트 verifier는 신뢰 프로세스다. 검증 시작 후 강제 종료 시 running/proof 없음으로 남고 자동 재실행하지 않는다. task.execute는 executable=false로 유지한다. 운영 migration·배포·서비스 재시작은 수행하지 않았다.


## 2026-09-08 P0-04/11 — 자비스의 후보 생성·독립 검증 통합 호출

- 이전 턴은 독립 verifier 구현 커밋 `07abcdb`로 progress였다. 이번에는 `executeCertifiedTaskCandidate`가 기존 후보 생성, 검증 예약, 별도 Node 검증기 실행, 서명 재검증과 증거 저장을 한 호출로 연결했다. 최종 원본 반영이나 workflow 완료와는 구분한다.
- 부모 runner는 고정 built entry를 빈 환경/cwd `/`/shell=false로 실행한다. 실제 spawn 직전에 reserved 상태와 현재 권한·마감을 확인하고 monotonic 타이머로 시간 제한을 적용한다. stdin 4 MiB, proof/진단 출력 합계 516 KiB 상한이며 stdout/stderr 원문 오류를 내보내지 않는다. timeout/output/input 실패는 프로세스 그룹 종료 후 close를 기다린다. 해당 예약의 실패만 operation uncertain으로 남긴다.
- 독립 리뷰 P2 1건: AuthorityDb의 기본/상대 filename을 그대로 넘겨 후보 생성 후 verifier가 실패했다. 실제 상대경로 연결 및 메모리 DB 회귀 2개에서 실패를 확인한 뒤 `PRAGMA database_list`의 실제 main 절대경로를 전달하고 공유 불가능한 DB는 모델 호출 전에 거부했다. 재리뷰 추가 필수 지적 0건.
- 최종 관련 회귀 6파일 75개 통과: 통합 후보 실행 27, 부모 process 경계 12, 서명 certification 26, certification 실제 프로세스 1, verifier 실제 entry 4, 공통 spawn 경계 5. timeout/출력 초과 시 close 이전에 완료하지 않는 것, 취소 직전 spawn 차단, 알려지지 않은 키/검증기 미설정 시 provider 호출 0회, 실패 proof 보존과 재호출 차단을 포함한다. typecheck/lint/build:backend exit 0.
- 최초 실제 통합 실행 02:11:28 KST는 빌드 entry의 mode 664 때문에 TASK_VERIFIER_UNAVAILABLE, provider 호출 0회/operation 0개로 중단됐다. 이번 생성 산출물 `dist/src/task-verifier-main.js`의 group/other 쓰기 권한만 제거하여 mode 644로 맞춘 후 재실행했다. 제품 검사를 완화하거나 소스/운영 release 권한을 바꾸지 않았다. clean build·배포의 전체 코드/의존성 권한 정규화는 후속 packaging/readiness 범위다.
- 2026-09-08 02:12:42 KST 실제 통합 호출은 Claude CLI 1회→후보 영속 저장→부모 NodeTaskVerifierProcess→별도 Node entry/bwrap→서명 증거 저장을 통과했다. 로컬/독립 검사의 syntax·answer-value 각각 exit 0, 원본 answer 41 유지, 후보 42, 동일 계획의 다른 승인 요청 재실행 거부, workflow running/request claimed/operation invoking/published=false를 확인했다.
- 실측 artifact `task-candidate:9fada51c8cd90fcbe8786d446653fb823641f1fb3e898f589ff49c96a467d225`, candidate digest `sha256:2be85dfedcd1584b45beb1dcc4b4e12f44f64a15cf46141540f48101051502b2`, verifier invocation `df4ccfc0-c157-4c1e-ac47-b1af2ff790e1`, fixture Git commit `cc9a70cc7cad0b15a6f363b6b6c46ec3742417df`. 로컬 증거는 `.runtime-tmp/task-certified-execution-live-smoke.json`; 격리 DB/키/저장소는 종료 후 삭제했다.
- 전체 verify는 재실행하지 않았다. 이전 공통 reviewability 실패(기존 5개 모듈)는 남아 있다. 전체 01–25 목표와 운영 인수는 미완료이며 다음 필수 연결은 현재 권한/원본 대조를 거친 파일 반영·부분 실패 복구, 검증 증거 기반 command/workflow 정산, 실행 UI다. task.execute는 계속 executable=false이며 운영 migration·배포·서비스 재시작은 수행하지 않았다.

## 2026-09-08 P0-04/11 — 승인된 새 Git 브랜치에 검증 결과 게시

- 직전 인계 턴은 수신 통합 계획 반영을 파일로 확인하고 인계 문서 상태를 갱신한 progress였다. 이번에는 현재 main `e61893e`와 병행 memory/dashboard 변경을 확인해 기존 미커밋 publication 단위를 이어갔다. 전체 01–25 범위는 유지한다.
- v2 실행계획에 verified_git_commit, 새 codex ref, 승인 전 root/git-dir/common-dir의 경로·device/inode digest를 포함했다. v1 후보 전용 승인을 확대하지 않는다. 입력 캡처·게시·복구에서 서명된 저장소 identity를 비교하고, 전체 read/write 입력이 Git baseline과 일치해야 검증된 write bytes만 private index에 반영한다. 최종 tree·허용 diff·단일 baseline 부모를 대조한다.
- Migration 063은 단일 publication 예약과 immutable binding을 기록한다. building→prepared의 예상 tree/commit을 먼저 COMMIT한 뒤 새 ref를 create CAS로 만든다. existing/symbolic/dangling symbolic ref는 교체하지 않는다. SQL 완료 실패는 uncertain, 실제 SIGKILL은 prepared로 남으며 조회는 ref_absent/ref_matches/ref_conflict만 반환한다. 조회 전후 total_changes 불변과 재게시 거부를 검증했다. 062 이하 바이트는 보존했고 063 SHA-256은 `15c8b870f3672428c6b9b6fa0461f2f71923f5be08e0eda9af6788a642a4fe87`이다.
- 독립 검토의 P1 두 건을 먼저 실제 격리 fixture에서 실패 재현했다. 인증 뒤 .git을 다른 동일-baseline 저장소로 바꿔도 게시됐고, refs/heads/codex의 외부 디렉터리 symlink로 외부 ref가 생성됐다. 저장소 identity 서명과 bwrap 쓰기 mount 제한으로 차단했다. 추가 P1인 host 준비 경합은 common FD→refs→heads→codex의 O_NOFOLLOW 연결로 보강했고, common.check 직후 저장소를 바꾸는 회귀에서 외부 codex 디렉터리 생성 0개를 확인했다. 최종 독립 정적 리뷰 추가 필수 지적 0건이다.
- Git은 고정 `/usr/bin/git`·환경 초기화·network namespace로 실행하며 metadata는 읽기 전용, FD로 고정한 objects/codex ref/private index만 쓰기 가능하다. 작업 파일·홈·키·DB는 mount하지 않는다. 객체 fanout symlink의 외부 쓰기와 복구 조회 시 다른 저장소의 동일 ref 위장도 거부했다. 최초 sandbox 정상 시험은 `/git/refs/...` 별칭의 read-only mount 때문에 실패했고, 같은 common/git-dir의 codex 디렉터리만 동일 FD로 연결해 통과했다.
- 최종 관련 고유 테스트는 10파일 171개 통과: publication 17, 실제 publication process 2, plan 35, staging 8, workspace 16, provider 12, candidate execution 27, certification 26, artifact 21, migration 7. 마지막 assertion 보강 후 publication/plan/migration 3파일 59개를 재실행해 통과했다. 추가 SQL 교체/삭제/역전 거부 검사에서는 trigger 실행 순서에 따른 메시지 가정 1건을 제거하고 실제 거부 및 원장 바이트 불변으로 검사했다.
- 첫 넓은 선택 명령은 `.runtime-tmp`와 `.chatgpt2codex`의 과거 복제 migration suite까지 포함해 12파일 181 pass/4 fail이었다. 현재 소스 10파일은 통과했고, 과거 복제 테스트 4개 실패를 최종 고유 수치에서 제외했다. 후속 선택에는 두 임시 경로와 `.omo`를 명시적으로 제외했다. 운영/과거 복제 파일을 수정하거나 테스트 실패를 제품 성공으로 처리하지 않았다.
- 실제 통합 호출은 2026-09-08 02:56:41 KST에 Claude CLI 1회→후보 영속 저장→로컬 검사 2개→별도 Node verifier/bwrap 검사 2개→Ed25519 proof 검증→새 Git ref 게시로 통과했다. 격리 저장소의 answer.mjs만 41→42가 되었고 기존 HEAD·index·작업 파일은 그대로였다. 같은 계획의 다른 승인 재호출도 차단했고 provider 호출 수는 1회로 유지됐다.
- 실측 게시 commit `dba5c7349a875574b23e591d0d5c888fbddb02b6`, baseline `0fdecb9e03cebdbb1e82b6402877487e28424f9d`, tree `8e53ebfb3d7ea6542c2dc3b7bd0eed052c588394`, ref `refs/heads/codex/actual-fixture-result`다. artifact `task-candidate:6e0e9fa2fc507098bf082bb159e7e6666b45639e8860688e3fb83dbb12bdaf60`, verifier invocation `033dca38-f472-4b01-a875-4a67d3ca2001`. 증거는 `.runtime-tmp/task-git-publication-live-smoke.json`이며 격리 DB/키/Git fixture는 종료 후 삭제했다. 실제 도구를 사용한 합성 코드 작업이고 운영 업무/배포 인수는 아니다.
- typecheck/lint/build:backend exit 0. 공통 reviewability는 2개 중 1개 실패: control-plane.ts 265 nonblank, index.ts 255, memory-outbox-store.ts 270, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 278. 새 publication 모듈은 모두 상한 이내이며 전체 verify 통과를 주장하지 않는다.
- 보류/후속: 검사 후 파일 rename만 하는 기존 작업 트리 자동 덮어쓰기는 동시 수정 CAS 및 다중 파일 중단 복구를 보장하지 못해 보류했다. 이번 승인 결과는 새 브랜치의 코드 커밋이다. 기존 브랜치 반영·merge·push는 별도 효과로 연결해야 한다. 아직 operation invoking/request claimed/workflow running이며 증거 기반 command/workflow 정산·결과 UI·Codex provider·packaging/readiness·강제 종료 후 index/객체 보존 관리·전체 운영 인수가 남아 있다. task.execute는 executable=false를 유지하며 운영 DB migration·서비스 재시작·배포는 수행하지 않았다.

## 2026-09-08 P0-04/11 — 검증된 Git 결과의 command/workflow 완료 정산

- 직전 인계 확인 턴은 기존 계획 반영 상태를 재확인했으며 자비스 개발의 변경은 없어 no progress로 분류했다. 이번에는 main `c4c5c98`의 실제 변경을 읽고 미커밋 완료 정산을 이어갔다. 전체 01–25 목표는 유지한다.
- `executeTaskWorkflow`는 현재 v2 승인·정확한 기본 graph·예산을 검사하고 후보 생성→독립 서명 검증→Git 게시→완료 정산을 연결한다. v1 후보 전용 승인은 모델 호출 전에 거부하며 실패 검증은 candidate_certified/published=false로 보존한다. 기존 executeTaskPlan 반환 계약은 유지한다.
- Migration 064는 run별 단일 immutable 완료 영수증을 추가한다. 현재 publication/proof/권한/실제 ref를 확인한 뒤 한 IMMEDIATE transaction에서 receipt, operation confirmed, command completed/effect, workflow step/transition/완료/event를 확정한다. 실제 수행하지 않은 observe/assess/approval 이벤트를 만들지 않고 task_verified 1회에 현재 node와 증거를 결합한다. step/node 예산도 각각 1회 소비한다.
- 일반 정산 API 및 SQL의 receipt 없는 task 완료를 차단했다. 독립 리뷰에서 지적한 기존 task 원장의 rowid 교체 우회를 보강했다. INSERT OR REPLACE의 새 비-task 내용과 rowid/_rowid_/oid 충돌, UPDATE OR REPLACE의 task source/target 충돌 모두 원장 바이트 불변으로 검사했다. 마지막 독립 정적 재검토 추가 필수 지적 0건이다.
- 064 SHA-256은 `9529ba06a9d5c0d8d5ee54e4bd753710bd5c361ffc5bf4313258178f534063d9`이며 migration 회귀에 고정했다. 001–063 SQL 바이트는 변경하지 않았다.
- 관련 고유 회귀 11파일 139개 통과: 완료 정산 15, SQL/graph/예산 경계 25, 실제 완료 process 3, 통합 workflow 2, migration 7, 기존 operation 18, loopgraph 5, publication 17, certification 26, approved executor 10, control plane 11. 최초 신규 fixture의 잘못된 graph 수정/transition 가정 2개와 신규 테스트 타입·구문 오류는 수정 후 해당 suite/타입 검사에서 해소했다.
- 실제 Node process의 COMMIT 전 SIGKILL은 receipt 0/claimed/invoking/running, COMMIT 후 SIGKILL은 receipt 1/completed/confirmed/completed로 복구됐다. 여전히 유효한 published 요청의 정산만 재시도할 수 있고 이미 완료한 재호출은 total_changes 불변이다. 두 실제 process 경쟁도 완료 영수증·workflow event·step·command effect 각각 1개였다. 이는 프로세스 종료 복구이며 전원 장애 시험은 아니다.
- 실제 통합 smoke는 2026-09-08 03:24:42 KST에 Claude CLI 1회→로컬 검사 2개→별도 Node verifier/bwrap 검사 2개→Ed25519 proof→Git 게시→최종 정산으로 통과했다. 요청 completed, operation confirmed, workflow completed/current_node complete/attempts 1이다. 별도 DB 연결에서 동일 완료 영수증과 artifact를 회수했고, 만료 시각 이후 동일 요청 재호출에서도 provider 1회와 total_changes 불변을 확인했다.
- 합성 저장소 baseline `2fd5a19d009e0a4329cc8853f90ae419372830c7`, 결과 commit `44ca5f69a3dc8478903d5297105a06a16dd57b90`, tree `8e53ebfb3d7ea6542c2dc3b7bd0eed052c588394`, ref `refs/heads/codex/actual-fixture-result`다. answer.mjs만 41→42이며 HEAD/index/작업 파일은 보존했다. publication `task-publication:8f4862c1-87c3-4328-b25c-c46a82faca8d`, 완료 `task-completion:2360e016d5ad6440c3a81386fb30ae0851f7689049d22ef8dc8356c461320834`, verifier invocation `86ecf3c1-ac0f-4d00-9fcb-e99ac539ae85`. 증거 `.runtime-tmp/task-completion-live-smoke.json`; 격리 fixture DB/키/Git은 종료 후 삭제했다. 실제 도구를 사용한 합성 코드 작업이며 운영 업무 인수 완료는 아니다.
- 전체 lint exit 0, 기존 strict tsconfig를 상속한 변경 파일·테스트와 전이 import 타입 검사 exit 0, diff whitespace 검사 exit 0. 전체 typecheck/build 시도는 병행 작업의 `tests/integration/memory-candidate-intake-cli.test.ts:44` 인수 1개 부족 TS2554로 exit 2였다. TypeScript가 emit한 현재 완료 모듈과 migration 복사로 실제 process/smoke를 수행했으며, 전체 build 성공으로 보고하지 않는다.
- 공통 reviewability는 2개 중 1개 실패: control-plane.ts 265 nonblank, index.ts 255, memory-outbox-store.ts 270, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 278. 신규 완료 모듈은 nonblank 99/66/44, 최대 줄 156/149/151이며 상한 이내다. 전체 verify는 통과했다고 주장하지 않는다.
- 남은 필수 범위: Approved executor·CLI/UI의 완료 호출 연결, Codex provider, 패키징·운영 readiness, 실패·만료·취소·uncertain publication 복구와 보존 관리, 전체 운영 인수다. 정확한 기본 graph 외 완료는 추가 gate를 건너뛸 수 있어 보류한다. Git 관측과 DB COMMIT은 원자적이지 않으며 완료 receipt는 observed_at와 immutable commit/tree의 과거 사실이다. task.execute는 executable=false를 유지하고 운영 migration·재시작·배포·push는 수행하지 않았다.


## 2026-09-08 P0-04/11 — 승인 실행기·CLI의 실제 작업 런타임 연결

- 직전 인계 확인 턴은 자비스 개발 상태 변경 없이 기존 계획을 재확인해 no progress로 분류한다. 이번에는 현재 main `73d59df`와 미커밋 실행 연결을 대조하고 정리·검증했다. 전체 개선 01–25 목표는 유지한다.
- ApprovedCommandExecutor가 task.execute를 claim 전 전용 경로로 전달한다. v2 계획·정확한 기본 workflow·현재 binding, 명시적 Claude 실행파일/검증기 키 구성과 sandbox 준비를 확인한다. 준비 실패 시 승인·operation·모델 호출을 소비하지 않으며 비동기 검사 뒤 현재 권한과 시각을 다시 확인한다. CLI check-task는 실행 가능 여부와 사유, authentication=not_probed를 반환한다.
- CLI control.execute와 dashboard authority 실행 경로가 기존 후보 생성→독립 Node verifier/bwrap→서명 검증→Git 게시→064 완료 정산을 사용한다. 완료 재조회는 런타임 설정을 제거하거나 승인이 만료돼도 추가 claim·모델 호출 없이 영속 완료 영수증을 반환한다. action descriptor의 executable=true는 handler 존재이며 운영 호스트 구성 완료를 뜻하지 않는다.
- 실패 검사는 command failed, 결과 불확실 예외는 uncertain으로 남긴다. IMMEDIATE transaction 잠금 획득 후 시각을 읽고 자신의 receipt/fence/operation만 정산한다. 완료 receipt·기존 취소·만료 상태를 덮어쓰지 않는다. 정산 event rollback은 재시도하지 않고 TASK_EXECUTION_SETTLEMENT_FAILED로 반환한다. 원문 모델/검증기 오류는 노출하지 않는다.
- 독립 리뷰에서 자동 순차 microloop의 모델 호출이 관찰/GJC/복구를 막는 문제, dashboard 고정 clock, 이미 uncertain인 operation의 실패 정산을 보강했다. task.execute는 자동 순차 큐에서 제외하고 CLI/dashboard의 명시 실행으로 연결했다. 실패 정산 clock의 transaction 전 관측도 수정했다. runbook 오류 분류 함수를 동일 조건으로 이동하고 두 기존 모듈을 가독성 상한 안으로 정리한 후 추가 독립 리뷰 필수 지적 0건을 확인했다.
- 최종 기능 회귀 12파일 115개 통과: 승인 task 17, runtime 4, approved executor 10, microloops 6, runbook 5, 완료 정산 15, control plane 11, staging 8, dashboard authority 6, action 계약 3, operation 18, provider 12. 전체 typecheck/lint/build:backend exit 0, diff whitespace 검사 exit 0. 별도 reviewability 2개 중 1개 실패: control-plane.ts 267 nonblank, index.ts 255, memory-outbox-store.ts 270, memory-remember-artifact.ts 최대 줄 202, second-brain-adapter.ts 278. 이 5개 공통 구조 부채는 남았으며 전체 verify 성공으로 보고하지 않는다.
- 실제 CLI smoke 증거를 재확인했다. 2026-09-08 03:42:33 KST, built plan-task→check-task→서명된 승인→control.execute에서 Claude CLI 호출 1회, 로컬 검사 2개와 별도 verifier 검사 2개 exit 0, Ed25519 proof 검증, 새 Git 결과와 완료 영수증을 확인했다. readiness 중 모델 호출 0회, 설정 제거 후 재조회도 추가 호출 0회다. 별도 DB 연결에서 같은 artifact/receipt를 회수했고 요청 completed/operation confirmed/workflow completed였다.
- baseline `9a58e372e35c691e28f1469a9b6ee1ac1d53a1c8`, 결과 commit `8860ddd86ed58e9aef0679363a05428ccb20e5c2`, tree `8e53ebfb3d7ea6542c2dc3b7bd0eed052c588394`, ref `refs/heads/codex/actual-fixture-result`. 완료 receipt `task-completion:f8e108f112dae509b3e1c7de47d626ea6da9b343f74e7dcca043e34f88463c23`, verifier invocation `4241d1d3-e0bc-44ad-8c2b-a49b40e79df9`. 로컬 증거 `.runtime-tmp/approved-task-cli-live-smoke.json`. 격리 Git의 answer.mjs만 41→42이며 HEAD/index/작업 파일을 보존했다. 실제 도구를 사용한 합성 코드 작업이고 운영 배포·실제 앱 전체 인수는 아니다.
- 보류: 자동 모델 스케줄링은 비차단 실행·복구 계약이 필요하다. Codex provider는 명시적으로 unsupported이며 암묵적 Claude 대체가 없다. 기존 작업 트리 자동 덮어쓰기/병합, 기본 graph 외 자동 완료, 불확실 작업의 모델 재호출도 계속 보류한다. 남은 범위는 UI 계획 작성·결과 상세·실제 전체 사용자 동선, 운영 packaging/readiness·복구/보존 관리와 공통 구조 부채 해소다. 이번 단위에서 migration·운영 DB·서비스·배포·push 변경은 없다.


## 2026-09-08 P2-14/18 — 런타임 조회·통신 경계와 공통 검증 복구

- 직전 goal 턴은 실행 연결 커밋 `9762b53`으로 progress였다. 이번에는 해당 HEAD와 작업 트리를 재확인하고 구조 검사 위반 5개를 처리했다. 전체 01–25 및 실제 업무 UI/운영 인수 목표는 유지한다.
- ControlPlane의 suppression 적용 단건/목록 조회와 저장 행 해석을 읽기 함수로 분리했다. 메모리 완료 정산은 기존처럼 원본 행을 decoder에 전달한다. MemoryOutboxRecordReader로 saga get/list/terminal replay를 옮기고 Store의 상태 전이 transaction은 보존했다. Second Brain의 transport·fence·generation 정규화·오류 분류는 호출 모듈로 분리하며 public read별 Map 수명을 유지한다.
- Orca/GJC 공개 API를 묶고 index의 runtime export 339개 및 타입 포함 export 791개의 추가/삭제가 각각 0개임을 대조했다. Python whitespace 문자 집합을 한 상수로 재사용하며 U+0000~U+10FFFF의 1,114,112개 코드포인트를 기록 양 끝에 놓은 이전/이후 parser 비교에서 차이 0개다.
- 구조 검사 상한은 바꾸지 않았다. control-plane nonblank 267→246, memory-outbox-store 270→242, second-brain-adapter 278→243, index 255→205, memory-remember-artifact 최대 줄 202→146. 새 조회/통신/API 모듈은 32/43/52 nonblank. 다른 과거 검사의 ControlPlane 주석 제외 245행 상한도 충족했다. AST 정적 import/re-export 그래프 483→486 모듈, 기존 순환 3그룹 동일/신규 순환 0개. 전체 함수 복잡도 감소나 모든 구조 부채 해소를 뜻하지 않는다.
- 전체 verify는 runtime/lint/typecheck/backend+dashboard build를 통과한 뒤 backend 372파일에서 2,282 pass/6 fail로 exit 1, backend 시간 1,013.88초였다. 원인은 migration 064 기대 누락 2개, DISPLAY 미설정의 xvfb-run 시간 초과 1개, 새 provider access 검사를 반영하지 않은 filesystem 대역 2개, 과거 별도 행 상한 1개다.
- migration 기대값을 실제 064까지 갱신하고 access mock을 명시했다. 조회 전용 객체의 불필요한 상태를 제거해 동일 SQL/변환/suppression을 함수로 위임했다. 제품 X_OK 검사·권한/transaction·migration SQL·검증 상한은 보존했다. DISPLAY=:102의 실제 packaged Electron driver는 두 번째 프로세스 redirect 1회, 잘못된 링크 focus/navigation/resource/show/settle 각 0으로 통과했다. 기본 자동 가상 화면 경로를 수정한 것은 아니다.
- 실패 파일을 모두 포함한 후속 고유 회귀 10파일 69개 pass(8파일59 + HTTP7 + Electron3). 최종 typecheck/lint/build:backend exit 0, dashboard 26파일143개 pass, 고정 clock pre-GJC acceptance 및 최종 built CLI smoke exit 0. 전체 verify를 처음부터 재실행한 단일 exit 0 결과는 없으며 최초 전체 실패와 후속 검증을 구분한다. 독립 정적 리뷰 및 마지막 조회 함수 재검토의 필수 지적은 각각 0건이다.
- 최종 실사용 경로 검증은 실제 격리 Python MCP + built 자비스 CLI다. 후보 입력/확인 fixture→저장 접수→proved→outbox settled→control completed→두 클라이언트의 같은 sensitive record 64개 회수와 dashboard stored=true를 확인했다. 삭제 sequence 1 이후 무서명/과거 fence 거부, 삭제 evidence 0개, compile 준비 중 완료 cycle 1,405.000328ms, 재전송 0회, terminal replay settled, 잔여 review 파일 0개, cleanup/control 오류 null이다. 이는 실제 프로세스의 합성 업무이고 실제 사용자 앱·운영 서비스 인수 완료는 아니다.
- 증거는 `.runtime-tmp/runtime-module-verify.log`, `runtime-module-final-regression.log`, `runtime-module-dashboard.log`, `runtime-module-memory-acceptance-final.log`, `runtime-module-graph.json`, `runtime-module-public-types.json`, `runtime-module-whitespace.json`, `task33-display-diagnostic.log`다. 설계/결과는 `docs/planning/adr-runtime-module-boundaries.md`에 보존했다.
- 후속/보류: 자동 GUI 시작 preflight·시간 초과 자식 정리(18), 남은 context/authority/task 경계의 순환 3그룹(14), 실행 계획 작성·readiness·결과를 연결하는 UI(04/11), 운영 packaging/복구/보존 관리와 최종 인수. task 자동 모델 스케줄링·Codex provider·기존 작업 트리 자동 반영 보류는 유지한다. 운영 DB·서비스·schema·배포·push는 변경하지 않았다.

## 2026-09-08 P0-04/11 — 실행 계획 준비·승인 요청·완료 조회 HTTP 연결

- 직전 인계 확인 턴은 자비스 소스 변경이 없는 no progress였다. 현재 main과 병행 메모리 정정 변경을 대조하고 실행 UI의 필수 API 단위를 구현했다. 전체 01–25와 실제 사용자 동선·운영 인수 목표는 유지한다.
- 작업 ID와 승인된 workflow.start/spec/default graph를 검증한 뒤 사용자 지정 파일의 Git blob 해시·기준 HEAD·저장소 identity를 계산한다. 작업 파일·실행 비트와 대조하고 새 파일의 부재를 확인한다. 모델/DB/승인 변경 없이 내용 없는 미리보기를 반환한다. staging은 동일 계획을 재계산·비교한 후 기존 task.execute pending 요청을 생성한다.
- 기존 정확한 Origin/CSRF/64 KiB strict JSON POST 경계를 재사용했다. GET은 로컬 CSRF와 no-store를 적용하고 DB에서 최신 run/request 각 20개 및 잘림 여부, 검토 계획, 과거 완료 영수증을 반환한다. 조회 중 provider/Git 실행이나 권한 갱신은 없다. 새 자동 재시도·승인 경로를 만들지 않았다.
- 독립 검토 지적 2건을 수정했다. 마지막 작업 파일 검사에 host PATH Git이 섞이는 문제는 pinned 고정 Git inspector/identity/check를 전달하여 해결했고, 파일별 현재 작업·마감도 검사한다. Git discovery는 저장소 최상위를 확인한다. 해시 추가로 staging 크기가 초과되는 문제는 미리보기 계획 60 KiB 상한으로 차단했다. 최종 정적 재검토 추가 필수 지적 0건.
- 관련 backend 고유 8파일 98개 pass: 새 HTTP/계획 23, approved task 17, completion 15, dashboard authority 6, publication process 2, 구조 2, Git publication 17, workspace 16. PATH 앞 실행 wrapper 미호출, 긴 경로 126개, symlink/hardlink/dirty/mode/입력 크기·마감·잘못된 task/run·미승인 시작·현재 기준 변경 거부를 포함한다. dashboard 전체 26파일143개 pass. 최종 typecheck/lint/build:backend exit 0, git diff --check exit 0. 초기 테스트 fixture의 immutable redemption 삭제·존재하지 않는 listen 호출·this 타입 및 정규식 lint 오류는 수정했다. 병행 memory 정정 테스트 타입 오류 2건은 최초 검사에 있었으나 최종 typecheck에서는 0건이다. 전체 verify는 이번에 재실행하지 않았다.
- 04:42:44 KST built HTTP prepare→stage→fixture 키의 단일 사용 서명 decision→execute→status와 실제 Claude CLI/독립 Node verifier/bwrap를 통과했다. provider 1회, 준비/readiness 0회, 로컬/독립 검사 각 2개 exit 0. Ed25519 proof를 원장에서 재검증하고 별도 DB 연결에서 같은 artifact/완료를 회수했다. runtime 설정 제거 후 execute 재조회 및 GET도 추가 호출 0회, 원장 fingerprint 유지다.
- 실제 격리 Git baseline `47c50bad22a91c84ae061b62066a083581216549`, 결과 commit `52c9be2898d60b0bfb93fc6ddc76577ed8ed7498`, ref `refs/heads/codex/actual-fixture-result`, completion `task-completion:aea160b865227b8905f797da9d0785a0f2d01d335eaf7934cdc2ef322c68fa73`. answer.mjs만 41→42, 원본 HEAD/index/작업 파일 유지. request/workflow completed, attempt confirmed다. 증거 `.runtime-tmp/approved-task-http-live-smoke.json`; 격리 Git/DB/키는 정리했다.
- 이 결과는 실제 도구를 사용한 합성 코드 작업이며 브라우저 UI/운영 서비스 인수 완료는 아니다. 다음 구현은 기존 client/store/작업 화면에서 파일·검사 선택→검토→승인→장시간 실행과 연결 상실 처리→영속 결과 표시다. 운영 packaging/복구/보존, 구조 부채와 최종 01–25 인수도 남는다. Codex provider·자동 모델 스케줄링·기존 작업 트리 자동 병합 보류는 유지한다. 이 단위에서 운영 DB/서비스·migration·배포·push는 변경하지 않았다. 병행 memory-correction 변경은 커밋에서 제외한다.


## 2026-09-08 P0-04/11 — 작업 실행 화면·통신 복구·브라우저 인수

- 직전 인계 턴은 세컨드브레인 계획 반영을 읽기로 확인했고 자비스 개발 소스에는 변경이 없는 no progress였다. 이번에는 main `30e2024`의 미완료 화면 변경을 이어서 구현·검증했다. 전체 개선 01–25의 범위와 운영 인수 목표는 유지한다.
- 작업 상세에서 저장소·파일 read/write/new·검사 인수·시간·결과 브랜치를 입력하고 Git 기준 미리보기를 검토한 뒤 기존 승인과 task.execute를 실행한다. readiness는 task/run binding을 재확인하고 구성 가용성만 반환하며 모델 인증을 검사하지 않는다. 파일 원문·호스트 진단은 화면에 노출하지 않는다. 완료 commit/ref/time/receipt/독립 검증 ID는 영속 조회로 복원한다.
- 기존 API client/store에 붙였다. 준비/stage/check 45초, 최대 10분 작업 실행 660초 대기와 연결 상실 표시를 추가했다. task resource의 응답 순번·task 전환 검사를 적용하고 SSE/명시 조회를 하나로 합쳤다. 상세 재조회 중 입력을 보존하고 최신 상태 조회 중 승인·실행을 비활성화한다.
- 독립 검토의 첫 P2는 GET 실패로 컴포넌트가 제거되며 전송 차단이 사라지는 문제였다. store에 task/request 식별자를 보존하여 실패 GET→approved/빈 결과 복구→작업 이동 후에도 재전송을 막는다. 두 번째 P2는 일반 승인/Today 우회였다. 공통 컨트롤에서 task 실행을 React Router 상세 링크로 연결했다. 세 번째 P2는 failed의 일반 Retry 복제였다. 공통 retry 정책과 POST가 task.execute를 not_allowed로 거부하며 같은 run/plan을 복제하지 않는다. 최종 독립 정적 재검토 필수 지적 0건.
- 추가 회귀에서 신규 TASK 오류 매핑이 기존 TASK_NOT_FOUND 404를 409로 바꾸는 결함을 찾았다. 기존 매핑을 먼저 적용하고 추가 TASK만 안전한 409로 반환하도록 수정했다. 취소/재시도 4개 및 실행 HTTP 24개 재실행 통과. 마지막 함수 정적 검토 지적 0건.
- 최종 검증: dashboard 전체 29파일 160개 pass, backend 관련 고유 5파일 41개 pass(실행 HTTP 24·취소/재시도 4·승인 6·조회 5·구조 2), typecheck/lint/build:backend/build:dashboard exit 0, 고정 clock pre-GJC acceptance와 built CLI smoke exit 0, diff whitespace 검사 exit 0. 전체 backend/verify를 이번에 재실행한 것은 아니다.
- 기존 Playwright 회귀는 최종 **26/26 pass, 1.1분**이다. 처음에는 기본 `/tmp`의 errno -122로 fixture 생성 전 종료됐고, TMPDIR를 쓰기 가능한 `/home/jm/.cache/jvtest`로 지정했다. 다음 실행은 운영 phone gateway PID 1625717의 4176과 충돌했다. 운영 프로세스는 유지하고 fixture 1024 포트만 4186으로 분리했다. 과거 overview `/` 경로·영문 문구·완료/거절이 actionable 목록에 남는 기대값을 최신 제품 경로/한글/응답+목록 제거로 교정했다. 검증 조건이나 axe 기준은 낮추지 않았다.
- 05:19:33 KST 실제 Chromium→built HTTP→Claude CLI→별도 Node verifier/bwrap를 사용했다. UI에서 입력·계획 검토·승인 요청을 생성하고 일반 승인 목록→상세 링크를 통해 fixture 키의 단일 사용 서명을 제출했다. 모델 호출은 준비/readiness 0회, 실행 1회, 완료 페이지 reload·runtime 설정 제거 후 replay 추가 0회였다. 로컬/독립 검사 각각 2개 exit 0, 원장의 Ed25519 proof 재검증, 별도 DB 연결에서 같은 artifact/완료 receipt 회수를 확인했다.
- 격리 Git baseline `db02c4e04ab2a4be31fafc61f151942b09afd9dc`, 결과 commit `9f539dece315b7ce67eeee9a2b8a159dd05b0ac9`, ref `refs/heads/codex/actual-fixture-result`. answer.mjs만 41→42, 원본 HEAD/index/파일과 읽기 전용 검사 파일 보존. request/workflow completed, effect attempt confirmed다. 1440×1000·390×844의 계획/결과 네 화면 가로 넘침 0, axe serious/critical 0, 콘솔 오류/경고 0. Browser plugin not available이므로 설치된 Playwright를 사용했다. 증거·실행 스크립트·스크린샷은 `/home/jm/.cache/jarvis-ui-qa-20260908/`에 있다. 격리 DB/키/저장소는 종료 후 삭제했다.
- 실제 도구를 쓴 합성 코드 작업과 테스트 서명 인수이며 운영 배포/실제 서명 장치 인수를 뜻하지 않는다. 전송 ID 보존은 현재 dashboard store 범위로 브라우저 재시작·다른 탭에는 공유하지 않는다. 알 수 없는 stage가 서버에 기록되지 않은 경우 자동 차단 해제/재전송은 하지 않는다. 서버의 승인·operation 중복 효과 방지와 화면의 전송 억제는 구분한다.
- 보류 유지: Codex provider, 비차단 실행·복구 계약 없는 자동 모델 스케줄링, 기존 작업 트리 자동 병합/덮어쓰기, 기본 graph 외 자동 완료, 미확정 작업의 모델 재호출. 남은 개발은 운영 packaging/readiness·GUI 자동 가상 화면 시작/복구·보존 관리, 남은 구조 순환과 전체 01–25 인수다. 운영 DB·migration·서비스·배포·push는 변경하지 않았다. AGENTS/에이전트 설정/인계 문서 및 다른 작업 산출물은 이번 커밋에서 제외한다.

## 2026-09-08 P2-15/18 — 서버·GUI 설치/검증 분리와 프로세스 정리

- 직전 인계 확인 턴은 자비스 개발 소스 변경이 없는 no progress였다. 현재 HEAD `16da47a`와 미커밋 테스트 실행기 변경을 재확인하고, 활성 검사 프로세스 3594654의 worker가 `/proc` 재귀 mkdir에서 정체한 것을 확인한 뒤 소유 runner에 SIGTERM을 보냈다. 명시 TMPDIR는 기존 절대 디렉터리인지 먼저 확인하도록 수정하여 같은 경로를 즉시 거부한다. 전체 목표 01–25는 유지한다.
- root postinstall의 Electron 다운로드를 제거했다. GUI 검증/패키징 명령이 명시 설치를 담당하며 backend/dashboard 빌드와 unit/integration/backend/dashboard/gui 검증을 구분한다. 기존 GUI source 계약 2개는 backend 파일로 이동했다. CI는 서버 verify·GUI·Chromium E2E를 모두 실행하도록 변경했고 30분 제한을 적용했다. 원격 CI를 실행한 결과는 아니다.
- 공통 실행기가 사용자 캐시에 0700 run 디렉터리를 만들고 4 KiB 쓰기/fsync/읽기 비교 후 TMPDIR/TMP/TEMP로 전달한다. 실패·시간 초과·SIGTERM/SIGINT 후 자신의 프로세스 그룹과 파일을 정리한다. Linux headless는 private /tmp·PID namespace와 인증 cookie로 Xvfb를 시작하고 xdpyinfo로 접속을 검증한다. 기존 DISPLAY가 잘못되면 다른 화면으로 자동 전환하지 않는다.
- 독립 리뷰에서 headless /tmp 재마운트가 이전 TMPDIR를 가리는 문제와 중첩 detached 그룹의 종료 누락을 찾았다. GUI 내부 TMPDIR=/tmp를 명시하고, 최상위 AbortController는 TERM→1초 KILL, 내부 helper는 기존 exit handler보다 앞선 동기 소유 그룹 정리로 구분했다. 외부/내부/leaf 3단계 실제 프로세스에 최상위 SIGTERM/SIGINT를 보내는 회귀를 포함했다. 마지막 정적 재검토 필수 지적 0건이다.
- 관련 통합 4파일 20개 pass, dashboard 29파일160개 pass, 최종 구분 후 GUI 2파일2개 pass, E2E 26개 pass(1.2분). typecheck/lint/backend+dashboard build와 새 MJS 4파일 구문 검사 exit 0. 명시 invalid DISPLAY exit 2, 새 private /tmp entry 및 기존 DISPLAY=:102 GUI exit 0, 해당 probe 임시 파일 삭제를 확인했다.
- 실제 GUI 중단 인수: node runner/Vitest/driver/Electron 7개를 실행 중 관측하고 최상위 SIGTERM을 보냈다. exit 130, 남은 대상 0개, runner 임시 디렉터리 삭제를 확인했다. 실행 중인 사용자 Xserver는 유지했다. POSIX의 직접 SIGKILL/호스트 종료 정리를 일반적으로 보장하지 않으며 macOS/Windows 실제 실행은 아직 검증하지 않았다.
- manifest/lock만 복사한 격리 offline npm ci는 348 packages/3초/exit 0, Electron dist 없음, native SQLite SELECT 1→1이었다. discovery 실측 backend 378파일(unit152/integration216/longitudinal10), GUI2파일, 누락/예상 밖/교집합 각 0이다. unit+integration만 실행하면 longitudinal 10파일은 포함하지 않으므로 전체 backend를 대체하지 않는다.
- 초기 전체 unit 검사 1,022 pass/4 fail은 병행 V3 기억 계약 구성 중의 결과다. 현재 전체 verify는 실행 중이며 Task32의 migration 064까지 기대값에 이후 065/066이 더해지는 첫 실패를 확인했다. 전체 gate 통과로 보고하지 않는다. 상세 결과와 남은 실패는 후속 단위에서 수집·해결한다. 이번 작업 중 병행 기억 계약/066 소스는 수정하지 않았다.
- 증거·실행 스크립트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`. 설계·명령·제약은 `docs/planning/adr-test-runtime-profiles.md`. 실제 /tmp 쓰기 errno -122와 중첩 namespace 생성 거부를 각각 기록했으며 명시 TMPDIR 실패를 숨기는 fallback은 추가하지 않았다.
- 보류 유지: Codex provider, 자동 모델 스케줄링, 기존 작업 트리 자동 덮어쓰기/병합, 비기본 graph 완료, 미확정 모델 재호출. 전체 검증 잔여 실패·운영 packaging/readiness/복구·보존·구조 경계와 최종 01–25 인수는 남는다. 이번 단위는 운영 DB/서비스/배포/push를 변경하지 않는다.

## 2026-09-08 P2-18 — 후속 마이그레이션의 검증 기대값 정리

- 직전 단위는 `24de897` 커밋으로 progress였다. 전체 verify의 실행 handle 70723은 계속 살아 있으며 별도 재시작하지 않았다. 과거 064를 마지막으로 고정한 테스트가 065/066 추가 시 실패하는 것을 확인했다.
- 빈 DB와 prior-031 DB의 업그레이드 검사는 격리 복사한 모든 SQL의 이름·SHA256과 실제 schema_migrations 원장을 정확히 비교한다. 031→032→033 순서, 체크섬 유일성, 기존 reviewed migration 49개 바이트 고정 검사는 유지했다.
- 전체 protocol 검사는 SQL 파일 목록과 원장의 완전 일치·번호 연속성·알려진 052~064 포함을 검증한다. 세 content-free 슬롯을 검증하는 HTTP 테스트는 052~054에 한정하고 request_json 부재·필수 테이블 검사는 유지했다. 새 마지막 번호가 추가될 때마다 무관한 HTTP 기대값을 수정하지 않는다.
- 실제 SQLite migration·업그레이드·바이트 변경 거부·HTTP 검증 3파일 15개 pass, 해당 파일 ESLint exit 0. 독립 정적 리뷰 필수 지적 0건. 제품 소스·SQL·운영 DB는 수정하지 않았다. 066/V3 변경은 병행 작업 소유이며 이번 단위에 포함하지 않는다.
- 전체 verify는 실행 중이다. 이번 관련 검사 통과를 전체 gate 통과로 표현하지 않는다. 05/06 상태 정확성, 08 조회 초기화 부작용, 12/13 운영 루프와 후속 01–25 완료 인수는 남아 있다.

## 2026-09-08 P2-18 — 전체 검사 결과와 acceptance 출력 복구

- 전체 verify handle 70723이 exit 1로 종료됐다. backend 378파일에서 2,367 pass/5 fail, 1,045.66초다. 실행 중 공유 작업 트리의 V3 기억 변경과 후속 05 연결 변경이 진행되어 고정 소스 SHA 전체 인수로 취급하지 않는다. dashboard/acceptance/smoke 단계에는 도달하지 않았다.
- 실패는 Task32 migration 기대값 1개, staged-execstart 스트레스의 Unix socket ECONNREFUSED 1개, 변경 모듈 가독성 2개, acceptance npm stdout 계약 1개다. migration은 `d6cfdd1`과 15개 후속 회귀로 해결했다. socket 실패는 현재 빌드로 재현 여부와 자식 종료/접속 준비를 후속 확인한다. 가독성은 현재 supervisor 변경 및 병행 memory 모듈들에 해당하며 최종 변경 후 다시 검사한다.
- 공통 실행기의 프로필 안내문이 acceptance/smoke stdout의 JSON 계약을 바꾸는 회귀를 수정했다. 두 machine-readable 프로필에서 안내를 생략하고 원래 stdout/stderr를 그대로 전달한다. 기존 골든·잘못된 입력 및 실제 npm subprocess 검증을 포함한 pre-GJC acceptance 4개 pass, Node 구문 검사 exit 0. 골든 기대값이나 실패 코드를 완화하지 않았다.
- 전체 목표는 활성 상태다. 현재 05 연결 상태 구현·독립 검토, 이후 06 집계·08 읽기 초기화·13 장애 분리·12 스케줄/보존과 나머지 인수 조건을 계속 진행한다.

## 2026-09-08 P1-05 — 구조화된 에이전트 연결 상태

- 직전 인계 턴은 수신 계획의 반영과 앱 패널 queued를 확인했지만 자비스 제품 개발에는 no progress였다. 현재 소스·기존 실행 handle을 다시 확인하고 연결 상태 단위를 이어갔다. 이전 build/typecheck/lint는 exit 0, 연결 회귀의 UNIQUE 충돌은 실제 실패였다.
- binding 등록만으로 live를 만들던 projection을 제거했다. 새 migration 067의 connected 0/1/NULL과 session/incarnation·관측 시각을 대조하여 live/offline/stale/unknown을 결정한다. TTL은 120초이며 카드 수는 live만 포함한다. HTTP list/detail의 같은 clock과 읽기 무변경을 유지한다.
- list/read 양쪽의 일시적 CLI 실패는 unknown, 신원 불일치·비정상 read는 cursor 보존 및 unknown이다. 기존 GJC 회귀에서 schema 오류까지 삼키면 서비스 실패 계약이 깨지는 것을 확인해 ORCA_CLI_FAILED만 허용했다. JSON/schema/권한 오류는 전파한다.
- 실제 Orca 1.4.197의 read status가 running임을 발견했다. 기존 fixture의 ok와 running을 정상 읽기로 허용하고 회귀를 추가했다. terminal prose는 저장/판정에 사용하지 않는다.
- 연결→해제→재연결 시 report_id만 달리해도 payload_digest UNIQUE가 충돌했다. 새 v3 payload에 previous_report_id를 포함하고 transaction 안에서 선행 occurrence를 선택한다. 기존 v2 미전달 보고서의 원문 recovery/ack는 유지한다. migration 001–066은 변경하지 않고 067 checksum을 고정했다.
- LiveSupervisor 공개 facade를 유지하며 binding/observation/report/resume 경계로 분리했다. 독립 정적 검토의 필수 결함은 최종 0건이다. 자동 resume·권한 검증을 현재 연결 상태로 대체하지 않는다.
- 최종 backend 관련 8파일 47개 pass(42.05초), dashboard 29파일 161개 pass(28.16초). typecheck/lint와 backend build exit 0. 실제 10,000회 staged-execstart·SIGKILL 재시작 테스트도 pass(2.03초); 앞선 전체 gate의 ECONNREFUSED는 이번 재실행에서 재현되지 않았으며 별도 socket 수정은 하지 않았다.
- 실제 읽기 전용 Orca list 2회/read 1회→격리 DB/HTTP에서 unknown→live→stale→unknown. stale은 120초 진행한 시계, 마지막 unknown은 주입 CLI 실패다. 각 list/detail의 쓰기 0, 터미널 변경 0, 실패 후 live 수 0, 격리 DB 제거를 확인했다. provider/session은 fixture 메타데이터이며 실제 모델 인증·업무 실행 인수와 구분한다.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/agent-accepted-regression.log`, `agent-dashboard-final.log`, `agent-live-probe.json`, `agent-stress-final.log`. 설계·호환·한계: `docs/planning/adr-agent-connection-observations.md`.
- 전체 verify의 가독성 실패에는 병행 memory 변경 4모듈이 남아 있다. 이 단위의 관련 검사 통과를 전체 gate 통과로 보고하지 않는다. 06 전체 활성 수, 08 생성자 쓰기, 12/13 운영 루프와 전체 01–25 인수는 남는다. 운영 DB/서비스/release/push는 변경하지 않았다.

## 2026-09-08 P1-08 — 조회 초기화 부작용 제거

- 직전 단위는 `e3871e5` 커밋과 실제 연결 검증으로 progress였다. 현재 HEAD와 작업 트리를 다시 확인하고 06/08의 공통 suppression 조회를 대조했다. MemoryProjectionLineage 생성자의 rebuild가 pending/failed/rebuilding을 조회 중 ready로 바꾸는 것을 첫 조회 회귀 4개 실패로 재현했다. 06 집계 구현 전에 이 공통 읽기 경계를 수정했다.
- 생성자는 재구축하지 않는다. `MemoryProjectionAuthority.initialize(now)`와 `db rebuild-projections --db <path>`가 명시적으로 수행한다. 기존 migration 검증 후 IMMEDIATE transaction 안에서 상태 확인→기존 계보 보충/quarantine→ready를 수행한다. 실패 시 원자 rollback, ready 재호출은 쓰기 0이다. 기존 SQL 바이트와 append-only 기록을 유지한다.
- 빈 command/task 목록·없는 ID를 포함해 suppression 준비 상태를 확인하고, HTTP의 NOT_READY는 고정 메시지의 503이다. 내부 409 변환부에서도 이 오류는 상위 503 처리부로 전달한다. 정상 조회가 DB 초기화·복구를 실행하지 않는다.
- 독립 검토에서 부모가 없을 때 binding을 생략하는 경로와 알림 SQL의 별도 전달 경계를 확인했다. 공개 bind/inherit·suppression activation의 transaction, hasLineage, 공통 binding helper, state 생성과 notification claim/settle에 준비 상태 검사를 추가했다. 구버전 테이블 부재 fallback과 실제 pending을 구분한다. 최종 독립 정적 검토 필수 결함 0건.
- 신규 7개 회귀: 세 비준비 상태의 읽기 무변경, populated HTTP/CLI 복구, 재구축 중간 실패 rollback·quarantine 보존·반복 무쓰기, singleton/clock 오류, 계보 쓰기·알림 외부 호출 차단. 관련 검사 5파일18개, 경계 확장 8파일46개, 기존 memory UI/HTTP 2파일13개 모두 pass. 신규 7개를 두 번 실행했으므로 중복 제외 14파일70개다. 각 로그는 projection-regression/projection-boundaries/projection-route-regression.log.
- 실제 격리 HTTP 서버와 별도 CLI subprocess로 pending/failed/rebuilding 각각 첫 GET 503·DB 쓰기0→명시 관리 명령 성공→같은 서버 GET200을 확인했다. 명령 재호출 후 singleton 기록 불변, 격리 DB 제거를 확인했다. 재현 스크립트·JSON은 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/projection-live-probe.*`.
- backend build·typecheck·lint는 exit 0. 설계·관리 명령·복구 제한은 `docs/planning/adr-memory-projection-initialization.md`. 운영 DB/서비스/release/push는 변경하지 않았다. 전체 verify와 06/12/13 및 나머지 01–25 완료 인수는 남는다. 전체 gate의 기존 memory 4모듈 가독성 실패는 이 단위와 별도로 해결해야 한다.

## 2026-09-08 P1-06 — 전체 활성 작업 집계

- 직전 인계 확인 턴은 수신 계획 반영의 증거를 확인했지만 자비스 제품 개발에는 no progress였다. 현재 main `36f00f2`와 미커밋 집계 변경을 다시 확인하고 기능 개발을 이어갔다.
- 공통 SQL population에서 work/workflow/command/GJC를 canonical task로 합성한다. 상태는 work→workflow→command→GJC 우선이며 같은 우선순위의 활성 기록을 먼저 선택한다. 최근 시각은 연결 기록의 최대 시각이다. 조회 시 실행 성공/만료 전이를 새로 쓰지 않는다.
- 전체 active COUNT와 최근 LIMIT는 하나의 SQLite 읽기 snapshot을 사용한다. 카드가 서버의 전체 집계 값을 사용하도록 변경했다. 전체 기본 원장 payload를 JS 배열로 가져오지 않는다. 추천은 기존 canonical/event 검증을 거쳐 한 건씩 합성하며 결과 배열만 LIMIT 이내로 유지한다. 일부 추천 순위가 종료되어도 남은 활성 순위가 있으면 진행 상태를 유지한다.
- 독립 리뷰의 별칭 P2 3건과 정렬 P2 1건을 수정했다. GJC가 아직 없는 continuation, workflow input와 다른 correlation, 추천에 연결된 intent의 상세도 같은 정본을 사용한다. 모호한 correlation은 임의 병합/조회하지 않으며 숨김은 연결된 모든 작업에 전파한다. SQL과 추천 병합 모두 UTF-8 BINARY 정렬을 사용한다. 최종 정적 리뷰 필수 결함0.
- 신규 회귀9개: 활성21/최근완료20, 숨김 후 목록 보충, work와 최신GJC 완료 분리, run/correlation 연결, GJC 없는 continuation 조회·숨김, 같은 snapshot의 동시 writer, 추천 일부/전체 종료 및 alias 상세, 최근 밖 증거 변조 차단, 모호한 alias, 동일 시각 혼합 정렬(일부 시나리오는 한 테스트에서 함께 검증).
- 관련 백엔드 중복 제외 9파일43개 pass. 실행 로그는 task-count-regression(8파일33), task-count-alias-regression(5파일23), task-count-final-regression(6파일34), task-count-accepted(최종 신규9)이며 겹치는 검사는 중복 집계하지 않았다. dashboard 29파일162개 pass. 최종 lint/typecheck/backend build 및 frontend build exit0, git diff --check exit0. 전체 verify를 이 단위에서 재실행한 것은 아니다.
- 실제 빌드 서버/Chromium: 격리 DB의 활성21/최근완료20을 API와 화면에서 확인, 활성 한 건 quarantine 후20/20, 각 조회 DB 쓰기0, page error0. 최초 probe는 목록이 링크라는 잘못된 DOM 선택자로 실패했으며 실제 p.record-title에 맞춰 수정하고 최종 exit0을 확인했다. 운영 데이터/서비스는 사용하지 않았다.
- 규모 표본: 격리 GJC 원장10,046행, 활성5,020/최근20. 5회 전체 집계+목록 시간은107.409/102.923/101.546/108.884/100.654ms, 중앙값102.923ms. 추천 대량 원장·운영 HTTP 부하 결과로 확대하지 않는다. probe 종료 후 임시 DB/브라우저 제거.
- 증거 경로: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/task-count-*`; 재현 스크립트와 최종 JSON은 `task-count-live-probe.mjs/json`. 설계는 `docs/planning/adr-dashboard-task-population.md`.
- 전체 목표는 미완료다. 기존 memory 4모듈 가독성 gate, 12 스케줄/보존, 13 관측 장애 분리 및 나머지 01–25 인수 조건을 이어간다. task 결과 자동 기억 수집은 원본 차단 전파 계약 미완성으로 기존 HOLD를 유지한다. 운영 DB/migration SQL/service/release/push 변경0.

## 2026-09-08 P2-14 — 메모리 스풀 중복 제거와 가독성 gate 복구

- 직전 단위는 P1-06 커밋 `ad9851856e4037dd43b3c73b805d707a4e12c4ca`와 HTTP/Chromium 실검증으로 progress였다. 현재 작업 트리를 확인한 뒤 P1-13의 콜백 경계를 대조했다.
- 실제 supervisor 콜백에 구조화 입력 처리와 보고서 output/ack가 포함되어 있어 전체 예외 무시 방식은 HOLD다. Orca runner와 JSON envelope 단계에서 오류 코드가 ORCA_CLI_FAILED로 합쳐지는 경로도 발견했다. 읽기 경계 격리·원인 보존·회로 차단·별도 상태의 후속 조건을 `docs/planning/service-observation-isolation.md`에 기록했다. P1-13 완료로 세지 않는다.
- 기존 전체 verify를 막던 memory 4모듈 중 dispatch spool의 remember/correct 공통 필드 조립을 한 곳으로 합쳤다. schema별 operation/body_profile/target과 receipt spread 우선순위를 유지한다. 다른 3파일은 V3 변경에서 추가된 긴 줄을 나눴다. 가독성 테스트나 상한은 변경하지 않았다.
- 현재 nonblank/maxLine: dispatch-spool243/141, material188/125, transport232/160, write-result54/132. task12 runtime reviewability와 기존 CLI intake·V1/V2/V3 dispatch·V3 wire·transport characterization 검사는5파일21개 pass, exit0. 새 구현을 그대로 복제하는 테스트는 추가하지 않았다.
- 실제 private spool 파일 발행·읽기·재발행으로 HEAD의 이전 구현과 작업 소스를 비교했다. V1 1,401bytes, V2 1,984bytes, V3 1,432bytes가 각 byte-for-byte 동일하며 재발행 created=false였다. 임시 파일과 fixture DB는 제거했다. 독립 정적 리뷰 필수 결함0.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/memory-reviewability.log`, `memory-spool-compat-probe.mjs/json`. 전체 verify는 이 단위 커밋 후 고정된 소스로 다시 실행한다. 운영 DB/service/release/push 변경0.

## 2026-09-08 고정 소스 전체 검증 및 strict JSON 경계 수정

- 직전 인계 확인 턴은 자비스 개발 기준 no progress였다. 기존 전체 검증 handle61865를 재확인해 계속 실행 중임을 확인했고 재시작하지 않았다. 고정 커밋 `ef46a2255d5225aa69a8a0deb98a1ac8c614fa31`의 `npm run verify`는 exit0: backend381파일2396개(1056.36초), dashboard29파일162개(27.22초), runtime/lint/typecheck/build/고정시계 acceptance/CLI smoke 통과. 로그 `verify-ef46a22.log`.
- Orca 읽기 경계 초안 검토 중 공통 strict JSON 파서의 특수 키 유실을 실제 dist에서 재현했다. `__proto__` 대입이 반환 객체 prototype을 바꾸고 키를 누락시켰다. 기존 MCP stdio에서도 extra-key 응답 두 종이 거부되지 않고 검색 data로 진행했다. 운영 제공자에 변조 응답을 주입한 것은 아니다.
- own data property 정의 후 기존 재귀 freeze를 유지하도록 수정했다. 정상 JSON의 키/중첩/직렬화가 보존되고 상위 schema가 예기치 않은 키를 거부한다. 기존에 왜곡되던 특수 키 입력의 직렬화/digest만 달라지며 계약 파일·해시·한도를 완화하지 않았다.
- 신규 parser4개/실제 stdio2개 회귀를 추가했다. 최초 red 실행은 MCP2개가 정상 결과로 진행하여 실패했고 parser 비교 실패 중 Vitest 오류 표시도 inherited readonly error에 걸렸다. 후속 검사에서 성공 초기화 진단의 기대값을0으로 바로잡고 constructor 특수 키 비교는 Node deepStrictEqual로 바꿨다. 최종 관련12파일84개 pass(18.21초): source/transport/profile/readiness/intake/V3/remote approval 포함. 로그 `strict-json-accepted.log`.
- 빌드된 자비스 transport와 실제 격리 MCP subprocess3개로 정상 응답의 도구 호출1, malformed null/object 응답의 호출각0, 시작각1, 자식 종료3을 확인했다. 임시 fixture 제거. 재현 및 결과 `strict-json-live-probe.mjs/json`. lint/typecheck/backend build exit0, 독립 정적 리뷰 필수 결함0.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`. 전체 verify 결과는 수정 전 고정 SHA에 귀속되며 파서 수정 후 전체 suite 재실행 결과로 확대하지 않는다. 파서 단위는 위 관련 검사와 빌드 실행으로 검증했다.
- P1-13 제품 경계는 아직 미반영: 중복 ok 성공 분기 우회와 wrapper 자손 파이프 종료 상한을 해결해야 한다. 상세 `docs/planning/service-observation-isolation.md`. 전체01–25 개발 목표와 자동 기억 수집 HOLD는 유지한다. 운영 DB/service/release/push 변경0.

## 2026-09-08 P1-13 선행 단위 — Orca 읽기 오류와 프로세스 경계

- 직전 턴은 `1a4b9d0` 파서 수정/검증/커밋으로 progress였다. 현재 작업 트리와 기존 경계 초안을 대조하고 중복 ok 분기 우회 및 자손 프로세스 종료 문제를 구현에서 해결했다.
- 공통 strict JSON 구현을 `strict-json.ts`로 분리했다. Second Brain 기존 제한/반환 규칙은 유지하며 Orca는 byte cap 내 큰 terminal list를 허용하는 별도 node/work budget을 사용한다. 전체 응답 중복 키 검사→형식 검사→성공/실패 분류 순서다.
- Linux 기본 실행 파일 `orca-ide`, 개발 `orca-dev`, 명시적 경로는 ORCA_CLI_COMMAND. 첫 사용 시 설정 고정, shell false. 1회5초/출력합계1MB/종료확인추가250ms이며 자동 재시도0. POSIX 소유 group을 성공과 실패에서 종료하고 close/kill 확인 실패는 runner 재사용을 차단한다. stderr prose·unknown 오류·권한·stale·설치·스키마를 transient로 바꾸지 않는다.
- 독립 리뷰에서 별도 stdio 자손이 정상/구조화 오류 종료 뒤 남는 P2를 추가 발견하여 close에도 group 종료를 적용했다. /proc 확인/읽기 경쟁은 ENOENT를 종료로 취급하도록 수정했다. 최종 필수 결함0. Windows 자손 정리/실측은 미완료이며 Linux 운영 결과로 확대하지 않는다.
- observeBound 및 remote/idle discovery가 명시적 runtime_unavailable/runtime_timeout만 격리한다. service에 pending sync를 둔 list/read 실패 검사에서 일시적 장애는 cursor 보존·unknown·sync completed, 권한/stale/schema/unknown 오류는 coordinator호출0·intent pending을 확인했다. 전체 supervisor 콜백 예외 무시는 계속 HOLD다.
- 최종 중복 제외 관련14파일132개 pass. 첫 실행은7파일 기능 회귀가 통과했으나 orca.ts의 긴 두 줄로 reviewability1개 실패했고 줄을 나눠 기존 gate를 통과했다. 신규18 envelope/15 process/8 observation 검사를 포함한다. 로그 `orca-read-first.log`, `orca-read-second.log`, `orca-read-final.log`. lint/typecheck/backend build exit0, git diff --check exit0. 이 변경 후 전체 suite를 재실행한 결과는 아니다.
- 실제 built runner: timeout507.16ms, wrapper 종료 후 stdout을 붙잡은 자손505.10ms, 별도 stdio 정상/오류 자손31.92/27.89ms, 그룹 밖 자손의 close 실패752.55ms. 부모5/자손4 종료를 확인했다. 그룹 밖 fixture는 runner 재사용 차단을 확인한 뒤 probe가 직접 종료했으며 자동 정리 성공으로 세지 않는다. 실제 설치된 Orca status 전후 성공, default adapter의 없는 handle 조회 ORCA_TERMINAL_STALE. 임시 fixture 제거.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`, 실제 재현 `orca-read-live-probe.mjs/json`. 운영 DB/terminal send/service/release/push 변경0. 상세 현재 계약과 미완료 조건은 `docs/planning/service-observation-isolation.md`.
- 다음 작업은 다음 시도 시각/backoff, incarnation 격리, 관측·coordinator 건강 상태 분리 및 실제 service 경로 검증이다. P1-13 전체와 나머지01–25 목표는 미완료이며 자동 기억 수집 원본 차단 HOLD도 유지한다.

## 2026-09-08 P1-13 — 영속 관측 재시도와 독립 건강 상태

- 직전 인계 확인 턴은 수신 계획 반영을 확인했으나 자비스 개발 기준 no progress였다. main `703d727`의 현재 변경분, 실제 probe JSON, 관련 검사 로그를 재확인하고 기존 handle85997의 exit0을 회수했다. 실행 중인 검사를 중복 시작하지 않았다.
- 새 migration068에 binding별 시도 토큰/시작 cursor/15초 만료/다음 시도/관측 성공 시각을 저장한다. 일시적 실패는 완료 시각부터10/20/40/60초, 상한60초 backoff이며 정상 관측에서 초기화한다. 건너뛴 시도는 외부 읽기·관측 쓰기0이다. 기존 migration 바이트는 유지했다.
- 시작/완료/최종 cursor·보고서 트랜잭션에서 신원과 cursor를 재검증하여 이전 시도 결과의 덮어쓰기를 거부한다. 만료·시계 역행도 거부한다. binding 자동 교체를 추가하지 않고 명시 교체된 신원은 이전 backoff를 상속하지 않는다. allSettled로 진행 중 reader 종료 후 오류를 전파한다.
- service status/doctor에 관측 건강 상태를 연결하고 coordinator 시도/성공 시각을 분리했다. heartbeat나 정상 관측이 coordinator 오류를 지우지 않는다. runtime lease 확인과 건강 상태 갱신을 하나의 IMMEDIATE 트랜잭션으로 묶었다. 보고서 recovery가 저장된 fatal을 우회하지 못하며 출력 실패는 ack0/coordinator0을 유지한다.
- 관련8파일55개 통과(48.52초), 마지막 만료 assertion 추가 후7개 재확인 통과(6.55초). build/typecheck/lint exit0. 독립 리뷰에서 최종 cursor 경쟁과 lease 확인/쓰기 사이 경쟁까지 수정했으며 최종 필수 결함0이다. 전체 verify 재실행 전의 관련 검사 결과다.
- 실제 빌드 CLI subprocess와 격리 Orca/GJC 프로토콜 실행 파일에서 실제 시계로9,531ms 대기 후 복구했다. 재시도 전 Orca 호출0·건강 상태 쓰기0, 별도 CLI status의 DB 커밋0, fatal 후 coordinator 호출0·intent 보존을 확인했다. 전체 fixture Orca호출10/GJC호출5, 임시 데이터 제거. 운영 제공자 인수 완료로 보고하지 않는다.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`: `observation-health-accepted.log`, `observation-health-expiry.log`, `observation-health-live-probe.mjs/json`, build/lint/typecheck 로그. 상세 계약은 `docs/planning/service-observation-isolation.md`.
- 단위 커밋 후 고정 소스 전체 verify를 실행한다. 운영 DB/서비스/release/push 변경0. P1-13 운영 인수와 전체01–25 목표는 미완료이며 자동 기억 수집 원본 차단 HOLD는 유지한다.

## 2026-09-08 전체 gate 재검증과 관측 계약 회귀 정리

- 직전 단위는 `bf533eb8e018a359d3bac365d41e60881da59b18` 커밋과 격리 CLI 검증으로 progress였다. 기존 전체 verify handle85154를 재사용했고 고정 소스를 유지했다. runtime/lint/typecheck/build 이후 backend의 파일 결과303개(실패5개 포함)를 출력하고 20분 TEST_RUN_TIMEOUT/exit2로 종료됐다. 나머지 backend·dashboard·acceptance·smoke는 이 실행에서 완료되지 않았다.
- 실제 회귀1개: Orca의 새 1MB 출력 제한 오류가 개인 커넥터의 수집 예산 초과로 매핑되지 않았다. 정확한 ORCA_CLI_OUTPUT_LIMIT만 기존 collection cap과 같은 PersonalSourceBudgetError로 변환한다. 다른 오류·출력 한도는 유지했다.
- 기존 기대값2개를 새 관측 계약에 맞게 구체화했다. 등록만 된 agent는 live0과 OBSERVATION_NOT_HEALTHY 위험을 표시하고 GET 쓰기는0이다. TIMEOUT의 unknown 처리와 일반 ORCA_CLI_FAILED의 fatal 거부를 각각 검증한다.
- 5초를 초과한 GJC8상태/기억 권한9만료 경계는 it.each로 독립 사례화했다. 모든 기존 assertion·독립 DB·finally 정리를 유지하며 timeout 상한은 변경하지 않았다. 개인 커넥터는33/10000/150000 각각을 검사한다.
- 최종 관련7파일68개 pass(55.61초), backend build/lint/typecheck exit0, 독립 정적 리뷰 필수 결함0. 실제 빌드 커넥터와 별도 CLI 실행 파일의33개/10000개 응답은 모두 PERSONAL_SOURCE_BUDGET_EXCEEDED(37.73/48.78ms)였다. 수정 전10000개 응답은 ORCA_CLI_OUTPUT_LIMIT이 그대로 전파돼 probe exit1로 재현됐고 수정 후 exit0이다. 임시 데이터 제거.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-bf533eb.log`, `observation-gate-regression.log`, `orca-connector-budget-red.log`, `orca-connector-budget-live-probe.mjs/json`. 전체 gate 통과로 보고하지 않는다. 다음은 전체 backend 실행 예산을 넘지 않는 분할 경로와 SSE 단위다. 운영 DB/서비스/release/push 변경0.

## 2026-09-08 P2-18 — 전체 backend의 순차 분할

- 전체 단일 backend 실행이20분에서 중단된 증거에 따라 기본 backend(args0)를 Vitest1/2,2/2 순차 호출로 변경했다. 필터와 다른 프로필의 기존 경로를 유지한다. 기존 backend include/exclude를 사용하므로 별도 longitudinal10개도 포함한다.
- 자식별20분/개별 테스트5초 기본값은 유지하지만 로컬 backend 전체 허용 시간은 최대40분(+정리)으로 늘어난다. 속도 개선이나 기존 전체20분 상한 유지로 표현하지 않는다. CI job30분 상한은 유지했다.
- 설치된 Vitest3.2.7의 수집387파일과 실제 BaseSequencer를 대조해194+193/중복0/누락0/longitudinal10을 확인했다. list --filesOnly는 shard를 적용하지 않으므로 이 출력만으로 실행 분할을 판정하지 않았다.
- 실제 wrapper/Vitest 격리 실행에서 첫 shard 실패 후에도4파일 각1회 실행·exit1 보존, 정상4파일 각1회·exit0을 확인했다. 기존 프로세스/취소/cleanup8개 회귀도 통과했다. 리뷰에서 분할 사이 취소에도 spawn할 수 있는 경계를 지적받아 사전 abort guard를 추가했고 실제 분할 probe와8개 회귀를 다시 통과했다. 최종 필수 결함0.
- 증거 루트의 `shard-discovery.json`, `test-shards-live-probe.mjs/json`, `test-shards-final.log`. 새 경로의 전체 suite 완료 증거는 아직 없으며 SSE 단위 이후 고정 소스로 실행한다. 운영/배포/push 변경0.

## 2026-09-08 P2-17 — SSE 버퍼 상한·밀린 알림 병합·재접속

- 전체 verify가 소스를 읽는 동안 캐시에 초안을 준비하고 별도7개 검사·HTTP 재현으로 대조했다. 전체 검사 종료와 회귀 커밋4bb5665/검증 실행기12c6b73 커밋 후 제품 소스에 반영했다.
- 기존20,000 burst의 writable 버퍼5,296,798bytes/첫false이후쓰기19,748회를 재현했다. 새 sink는16KiB프레임/128KiBwritable 상한, writefalse 이후 쓰기 중지, 큐 대신 dirty표시1개, drain 전체snapshot1회,5초 미복구종료를 적용한다. heartbeat는 기한을 연장하거나 dirty를 만들지 않는다.
- Hub의32토픽/UTF-8/JSONescape프레임 상한으로 공유 replay128개도 제한한다. 초과는 전체snapshot으로 축약한다. 구독자1개의 write예외는 다른 구독자를 중단하지 않는다. connect 중 종료에도 unsubscribe·타이머 정리를 수행한다. wire형식과 실행 권한 경계는 유지한다.
- 실제 반영본 관련backend7파일19개(8.40초), dashboard29파일162개(31.79초) pass. lint의 prefer-const 지적은 cleanup에서 heartbeat참조를 비워 수정하고 신규7개를 재통과했다. 최종 build/typecheck/lint exit0, 독립 리뷰 필수 결함0.
- 실제 built dashboard/paused TCP에140,000개 발행: write11,571/false41/막힌상태쓰기0/최대writable65,706bytes/첫20,000 burst65,616bytes/미복구종료5,002ms. 이는 writable 버퍼 측정이며 RSS·커널 메모리 상한으로 확대하지 않는다. 최초 probe의 수동blocked플래그는 drain listener 순서로 정상 재개쓰기를 오인해 실패했으며 최종은 Node writableNeedDrain을 직접 검사했다.
- 실제 Chromium에서 연결 종료 중 작업 추가·replay ID퇴출→자동재접속open2/snapshot2→카드1에서2로 갱신을 확인했다. 재조회DB쓰기0/pageErrors0. 임시 DB/브라우저 제거. 증거 `sse-live-probe.mjs/json`, `sse-live-probe-first.log`, `sse-regression.log`, `sse-dashboard.log`, `sse-cleanup-final.log`.
- 설계와 한계 `docs/planning/adr-dashboard-sse-delivery.md`. 정상 빠른 클라이언트의 동시 HTTP 재조회 중복 병합·조회 규모 개선은 후속이다. 전체01–25 인수, 최신 전체gate, 자동 기억 수집 원본 차단 HOLD는 유지한다. 운영 DB/서비스/release/push 변경0.

## 2026-09-08 전체 gate 확정 — 704f238

- 고정 SHA `704f238158513584ac9a763a638c738e18e27310`의 verify handle5972를 재사용하여 최종 exit0을 확인했다. 분할1:194파일1,243개/595.78초, 분할2:194파일1,236개/618.96초. 합계388파일2,479개로 사전 분할 대조와 일치한다.
- dashboard29파일162개/27.70초, runtime/lint/typecheck/build, fixed-clock acceptance와 마지막 CLI smoke 모두 verify의 순차 gate를 통과했다. 로그 `verify-704f238.log`. 앞선 bf533eb의 timeout/미완료 기록은 보존한다.

## 2026-09-08 P2-17 — 기본 대시보드·선택 작업 HTTP 조회 병합

- 전체 gate가 제품을 읽는 동안 캐시 사본에서 red2개를 재현했다: tasks 알림1,000+수동1→GET1,001회, 오래된 수동 응답이 새 데이터를 덮어씀. 사본에서 개선안을 검증하고 전체 gate 종료 후 제품에 반영했다.
- canonical4종과 선택 execution별 진행1/공유 후속1, event별 대기 체인 제거, 수동 refresh 후속 완료 대기, snapshot 연결 version fence를 적용했다. 버리던 task detail GET은 제거하고 canonical tasks revision 갱신을 사용한다.
- 리뷰의 무기한 대기 지적1개를 수정했다. 일반 GET에15초 실제 fetch/body deadline, helper 종료 AbortController, execution 기존 deadline과 caller signal 합성을 적용했다. 미완료 네트워크를 남기는 Promise.race는 사용하지 않는다. 최종 독립 리뷰 필수 결함0.
- 제품 dashboard30파일168개/31.07초 pass, lint/typecheck/dashboard build exit0. 테스트의 이전 응답 순서 재현을 정리한 뒤2파일8개/1.82초 재통과했다. 백엔드는 변경하지 않았으며 위 전체 gate 이후 frontend만 검증했다.
- 실제 built Chromium: reconcile1,002/snapshot1, held tasks GET1+후속1, agents/approvals 각1, 화면task1→2, 재조회DB쓰기0/pageErrors0. 실제 부분 JSON HTTP는15,007ms에 abort; 대기10,000알림 뒤 요청총2/완료1/중단연결닫힘을 확인했다. 임시 DB·서버·브라우저 제거.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`: `store-coalescing-red.log`, `client-coalescing-{tests,final-tests,types,lint,build}.log`, `client-live-probe.mjs/json/log`, `client-coalescing-browser.png`.
- 개인 dashboard snapshot 병합은 후속이다. memory 화면의 즉시 privacy 철회/검색 취소 순서를 보장하기 전 공통 큐 적용은 보류한다(기존 기능 유지). 작업→자동 기억 수집은 원본 차단 전파 부재로 기존 HOLD 유지. 전체01–25와 운영 인수는 미완료이며 운영 DB/서비스/release/push 변경0.

## 2026-09-08 P2-17 — 개인 대시보드 snapshot 병합

- 직전 bccdd91은 커밋·실제 브라우저/HTTP 인수를 완료한 progress였다. 현재 제품을 다시 확인하고 개인 store의 동기 burst/지연 disconnect 응답/철회 직후 캐시 세 경계를 red3개로 재현했다.
- 기존 네 API의 합성 snapshot을 진행1+공유 후속1로 병합했다. allSettled로 형제 요청이 남은 상태에서 다음 묶음이 시작되지 않게 하고, caller signal을 기존10초 transport deadline과 결합한다. 종료는 진행4개 취소 및 대기 해제다.
- 새 요청·disconnect·잘못된 SSE에서 sequence를 무효화하고 연결 실패를 보존한다. 철회 알림은 cached data를 동기 제거하며 이전 성공·실패 결과로 복원하지 못한다. 기존 memory-store는 수정하지 않았다.
- 제품 dashboard30파일174개/32.16초, lint/typecheck/dashboard build exit0. 독립 리뷰 필수 결함0. 실제 Today 개인SSE1,001회에 API각1+1, 추천0→3개, 철회 알림 후0개·최신 조회 후3개, DB쓰기0/pageErrors0. 원본 삭제가 없는 합성 알림 검사임을 명시한다.
- 실제 HTTP 중단: stop으로4요청/4body 닫힘. 오늘 API500과 health partial response를 함께 만든 후10,009ms에 timeout·후속snapshot 성공, 요청총8개. 임시 DB/서버/브라우저 제거.
- 브라우저 probe 첫 경로 /today 및 두 번째 h2 내부 selector는 probe 오류로 각각 timeout됐다. 실제 루트 /와 section selector로 수정해 최종 exit0을 확인했다. 제품 실패로 보고하지 않는다. 증거 `personal-live-probe-first.log`, `personal-live-probe-selector.log`, 최종 `personal-live-probe.mjs/json/log`, `personal-coalescing-*.log`.
- 별도 새 결함: 실제 빈 DB의 todayProjection을 실제 parseToday에 전달하면 freshness.checked_at 누락으로 VALIDATION_ERROR가 발생한다(`today-empty-contract-red.log`). 병합 기능의 완료와 구분해 바로 후속 수정한다. 전체01–25/운영 인수, memory-store 큐 보류 및 원본 차단 자동 수집 HOLD 유지. 운영/배포/push 변경0.

## 2026-09-08 Today 최초/차단 데이터 계약 수정

- 개인 조회 병합98509a9의 실사용 검증 중 빈 DB 응답과 실제 frontend parser를 직접 대조해 checked_at 누락을 재현했다. 최초 context 부재와 privacy로 context가 차단된 두 fallback에 checked_at:null을 추가한다. 원본 시각을 노출하거나 strict parser를 완화하지 않는다.
- 실제 HTTP 빈 DB 검사와 원본 차단11읽기 경로 검사에 정확한 freshness shape를 추가했다. frontend는 null을 허용하고 필드 누락은 계속 VALIDATION_ERROR로 거부한다.
- 관련backend3파일13개/15.65초, frontend3파일39개/3.82초 pass. backend build/lint/typecheck exit0. 독립 리뷰 필수 결함0. 현재 전체 frontend 최신 단위는 앞선174개 pass이며 이번 추가 parser1개는 집중검사에 포함했다.
- 실제 built Chromium/HTTP: 빈 DB Today no_data 렌더 성공, fixture 권한에 연결한 context·추천3개를 실제 tombstone으로 차단 후 추천0개와 memory_suppressed 표시. 두 경로 freshness={state:no_data,checked_at:null,fresh_until:null}, Today unavailable0/pageErrors0/GET DB쓰기0. 임시 DB/서버/브라우저 제거. 이는 격리 DB의 기존 원본 차단 경로 인수이며 보류 중인 작업 자동 기억 수집의 파생 차단 완료가 아니다.
- 증거 루트의 `today-empty-contract-{red,green}.log`, `today-empty-contract-probe.mjs/json`, `today-no-data-{backend,frontend,build,lint,types}.log`, `today-no-data-live.mjs/json/log`, `today-{empty,suppressed}-browser.png`.
- src/index.ts 및 memory-reference-context 관련 변경은 다른 작업 소유로 확인하여 이번 커밋에서 제외했다. 전체01–25 및 운영 인수 미완료, 기존 HOLD 유지, 운영/배포/push 변경0.

## 2026-09-08 P2-17 — 개인·기억 HTTP 본문 수신 제한

- 직전 인계 확인은 자비스 제품 개발 기준으로 변경 없는 조회였다. 현재 HEAD3360fe7과 미커밋 파일을 다시 확인하고 진행 중이던 response byte budget 수정을 이어갔다. 기존 dashboard 검사 handle79492의 최종 exit0을 확인했으며 검사를 중복 실행하지 않았다.
- 두 클라이언트의 response.text() 이후64KiB 검사가 EOF 없는 초과 stream을 취소하지 못하는 red2개를 재현했다. 고정 입력 버퍼65,539bytes와 수신 중 제한, 초과/중단 cancel·reader release를 적용했다. 기존64KiB decoded UTF-8 기준과 BOM/replacement/error code를 보존한다. 프로세스/브라우저 전체 메모리 상한으로 보고하지 않는다.
- 제품 dashboard31파일183개/36.47초 pass, lint/typecheck/dashboard build exit0, 독립 정적 리뷰 필수 결함0. 초과 응답, UTF-8 분할·정확경계·BOM, replacement 확대, 취소 실패/지연, 비정상본문8개 검사가 포함됐다. 전체 verify 최신 완료 SHA는704f238이며 이후 단위 검증과 구분한다.
- 실제 Chromium/native HTTP: 개인GET·기억GET·기억POST 각 plain/gzip6건을3~5ms에 거부, 각 요청1/연결닫힘1/자동재전송0. gzip wire118bytes→decoded70,012bytes, HTTP EOF 미전송. 실제 기억 삭제가 아닌 격리 HTTP fixture다. 정상 조회 복구2종과 정확64KiB 한글+BOM 수신도 확인했다.
- 실제 built Today는 초과gzip2응답/연결닫힘2회 후 SSE 재조회로 no_data 화면 복구, GET DB쓰기0/pageErrors0, 임시 DB/서버/브라우저 제거. 최초 probe의 Today 문구 selector 오류는 수정하고 최종 exit0을 확인했다. 화면도 직접 확인했다.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`: `response-budget-red.log`, `response-budget-{tests,lint,types,build}.log`, `response-budget-live.mjs/json/log`, `response-budget-live-selector.log`, `response-budget-recovered-browser.png`. 설계는 `docs/planning/adr-dashboard-sse-delivery.md` 후속 절.
- P2-16의 approval 전체 SQL 조회·keyset pagination·1만/10만 측정은 남는다. memory-store의 privacy 순서 검증 전 큐 적용 및 작업→자동 기억 수집 원본 차단 HOLD를 유지한다. 전체01–25/운영 인수 미완료이며 운영DB/서비스/release/push 변경0.

## 2026-09-08 P2-16 — 승인 목록 SQL·페이지·전체 pending 수

- 직전 b553634는 커밋과 실제 HTTP/브라우저 인수를 완료한 progress였다. 현재 HEAD와 변경 파일을 다시 확인하고 승인 read-model의 전수 control payload/행별 차단 조회를 SQL로 옮겼다. 별도 진행 중 기억 reference/CLI 변경은 보존했다.
- actionable 상태와 정확한 control_payload 차단을 SQL에서 평가하며 표시 메타데이터와 failed workflow의 retry 입력만 읽는다. 새 immutable069 부분 인덱스와 bounded keyset GET을 추가했다. 기존 무쿼리 v1 전체 목록·locale 정렬은 유지한다. 그 호환 경로는 결과 개수에 비례한다.
- React는50건 한 페이지와 처음/다음/현재페이지 refresh를 지원하며 요청 version으로 이전 성공/실패를 무효화한다. overview는 pending 전체 수/20개 미리보기, 카드도 전체 수, Today/overview는 전체 목록 링크를 사용한다.
- 독립 리뷰의 긴 ID cursor 지적1개를 수정했다. rowid+정렬 키/명령 digest 해시로 위치를 제한하고 실제 긴 키는 서버에서만 복원한다.4096byte ID 왕복, anchor 차단 후 다음 조회, anchor 이동의409/첫 페이지 복구, 현재 원본 차단·준비 상태·retry 계약을 검증했다. 최종 정적 리뷰 필수 결함0.
- dashboard32파일187개/33.73초, 마지막 mock 타입 정리 후4개/1.64초 pass. 관련 backend5파일26개는 기존4파일22개와 최종 page4개 pass로 확인했다. 마지막 HTTP409 assertion 포함4개/6.34초 재통과. typecheck/build/lint exit0. 첫 새 fixture의 args 형식과 immutable identity를 바꾸려던 검사는 정상 계약/rowid 이동으로 수정했다.
- 추가 task execution/migration/reviewability33개 중 기존 memory-reference-context190자 행1개 때문에32pass/1fail이었다. 해당 파일이 미변경인 것을 확인하고 instruction170bytes 동일성을 검증한 뒤 줄만 나눠 별도7fe1251 커밋했다. migration/reviewability9개/6.61초 재통과. 전체 verify 최신 완료 SHA704f238 이후의 단위 결과이며 새 전체 gate 완료로 확대하지 않는다.
- 실제1만/10만 합성 명령(90%completed/10%pending, args1024자padding): 이전 전체조회5표본 p95=246.421/2877.637ms, 새50개조회20표본 p95=0.487/2.489ms, HTTP20표본 p95=3.218/4.840ms. 반환bytes227030/2270030→11559/11560. SQL prepare호출30002/300002→5이며 SQLite내부상관탐색까지 센 실행횟수는 아니다. COUNT는 대상수에 비례한다.
- 대상1000/10000개를100개 페이지로 순회해 중복0/누락0, EXPLAIN 부분 인덱스·tuple seek·ORDER BY임시B-tree0, cursor 이후 차단 즉시반영/GET쓰기0을 확인했다. 실제 built Chromium은105개를50→50→5로 이동/첫페이지복귀, overview카드105/미리보기20/pageErrors0. 임시 데이터 제거. 첫 규모 probe의 두번째 DB 교체 후 이전model 참조 오류는 수정하고 최종 exit0이다.
- 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의 `control-page-live.mjs/json/log`, `control-page-live-closed-fixture.log`, `control-page-overview-browser.png`, `control-page-*.log`. 설계와 측정 조건은 `docs/planning/adr-dashboard-control-pagination.md`.
- P2-16의 전체overview state projection/timeline 비용과 다른 목록 범위/페이지 처리는 남는다. memory-store 큐 보류/자동기억 원본차단 HOLD, 전체01–25/운영 인수 미완료를 유지한다. 운영DB/서비스/release/push 변경0.

## 2026-09-08 P2-16 — overview 중복 projection과 population 조회

- 직전 인계 확인 턴은 자비스 개발 기준 no progress였다. 재개 시 HEAD63bdd02, 남은 소스/검사5파일과 실제 측정 산출물을 대조했다. 별도 memory CLI 커밋은 보존하고 이 단위를 마무리한다.
- overview에서 사용하지 않는 CURRENT_STATE 전체 계산과500개 timeline을 제거했다. 기존 doctor 검사와 provider 관측 이후 동기 조회를 하나의 snapshot으로 묶고 쓰기 감지 실패 시 rollback한다. 기존 응답/redaction 깊이와 추천 전체 identity/event 검증을 유지한다.
- 기본 visible population의 최근20개와 전체 활성 수를 한 SQL로 읽는다. 최초 초안은 LIMIT 전 source_ids 집계로1만 건6.9~7.2초 회귀가 발생하여 실행 중단/EXPLAIN 대조 후 폐기했다. bounded MATERIALIZED recent를 확정한 뒤 source_ids를 집계하는 최종안으로 재검증했다.
- 관련 backend10고유파일49개 통과, 최종 SQL 수정 후4파일20개/29.74초 및 reviewability2개 통과. build/typecheck/lint 통과, 마지막 SQL 이후 backend build/lint 재통과. 독립 리뷰 최종 필수 결함0. 새 전체 verify 통과를 의미하지 않는다(최신 전체 gate SHA704f238).
- 실제1만/10만 합성 명령 overview 이전5표본 p95=774.761/7400.408ms→이후10표본164.486/1338.501ms. HTTP5표본148.131/1251.268ms. prepare6137/60137→104, population statement6→2. SQLite내부 연산 수나 일정 시간 복잡도로 확대하지 않는다.
- 두 규모에서 전체 응답 및 원본 quarantine 이후 응답이 이전본과 일치하고 GET DB쓰기0이었다. 실제 built Chromium10만 건 최초표시10871ms, 카드9999/미리보기20→추가차단후카드9998, pageErrors0. 임시 자원 제거 확인. 최초표시 지연과500건 작업 목록/초기 재조회 비용은 후속 실측 대상이다.
- 근거와 한계는 `docs/planning/adr-dashboard-overview-query.md`, 증거 루트의 `overview-projection-live.mjs/json/log` 및 해당 ADR의 검사/실패 로그 목록에 기록했다. 전체01–25/운영 인수 미완료, 자동기억 원본차단 HOLD와 memory-store 큐 보류 유지. 운영/배포/push 변경0.

## 2026-09-08 P2-16 — 최근 작업 출처의 일괄 집계

- overview 단위33f8621 커밋 후 실제500개 task 목록을 분리 측정했다. 선택 task마다 normalized를 반복 조회하던 SQL은10만 건 limit500에서4257~4365ms였다. bounded recent에 normalized를 조인하고 task/source 중복 제거·BINARY정렬 후 한 번 집계하는 후보는861~873ms이며 전체 SQL행이 일치했다.
- 제품 source_groups CTE에 반영했다. 전체 count·추천 검증·현재 차단·순서를 유지하고 캐시나 영속 인덱스는 추가하지 않았다. 관련4파일21개/30.63초 pass, build/typecheck/lint exit0, 독립 리뷰 필수 결함0. 새 검사는501task×5Unicode출처·limit1/20/500·차단대체행과 family간 동일ID 중복 제거다.
- 실제1만/10만 목록500개 이전5표본 p95=468.730/4481.160ms→이후5표본92.873/877.947ms, HTTP111.149/970.204ms, 응답91,313/91,805bytes 동일. overview도 이전 응답과 일치, GET DB쓰기0.
- 같은 built Chromium10만 건에서 최초표시10842→3151ms, 초기+SSE 두 묶음11860→4060ms(각1회). 원본차단후카드10000→9999/목록500개에서차단source0/pageErrors0. 화면 확인/임시자원 제거 완료. 최초8API 재조회와 전체population비용은 남는다.
- 실제 probe 첫 import 실패와 Node callback시간의 부정확한 계측은 보존하고 수정했다. 최종은 브라우저 request.timing을 사용했다. 증거 `task-source-live.mjs/json/log`, query probe와 ADR 후속 인수 절 참조. 실행 범위표의 오래된04/06/10–13/14–19 상태도 기존 인수 원장에 맞게 갱신했다.
- 전체01–25 목표와 미완료 범위는 유지한다. 최신 전체gate는704f238이며 누적 변경의 새 전체검증이 필요하다. 자동기억 원본차단 HOLD와 memory-store 큐 보류 유지. 운영DB/서비스/release/push 변경0.

## 2026-09-08 전체 gate 확정 — a4a2ebc

- 기존 verify handle95258을 재사용하여 종료코드0을 확인했다. 시작·종료 HEAD는 `a4a2ebce785154193e685b97525f2e030ad5c5a2`, 모든 추적 파일의 실행 전후 byte hash 변경0이었다. 시작부터 있던 AGENTS.md/인계문서 수정2개는 별도로 기록됐고 제품 소스는 해당HEAD 상태였다.
- backend1분할196파일1271개/600.99초,2분할195파일1264개/644.09초: 합계391파일2535개 pass. dashboard32파일187개/30.81초 pass. runtime/lint/typecheck/build/fixed-clock acceptance/CLI smoke 모두 verify exit0으로 완료했다.
- 증거 `verify-a4a2ebc.log`, `verify-a4a2ebc-before.json`, `verify-a4a2ebc-after.json`, 실행기 `verify-current-source.mjs`. 일일 루프 초안과 검사는 캐시에서 준비했고 이 gate 종료 이후에 제품을 변경했다.

## 2026-09-08 P1-12 선행 — 일일 루프 결과·관측 종료 시각

- 이전 목표 턴은 새로운 red/green·실제 격리 재현을 만든 progress였다. 이번 재개에서도 전체gate의 동일 live handle을 재사용했고 소스를 보존했다. 캐시 초안 타입검사0/신규12pass/독립리뷰0을 확인하고 전체gate 종료 후 제품에 반영했다.
- cycle의 예산실패1개/startup의 실패3개가 completed_run_ids에도 들어가던 결함을 수정했다. 내부 advance결과를 step_completed/all_completed/failed로 구분하고 finish는 실제 store.complete성공후true를 반환한다. public runNext boolean/wire결과 구조는 유지한다.
- 느린 refresh_reader가 lease 만료 후 과거 시각으로 단계1개를 완료하던 경로에서 저장 직전 시각을 재조회한다. freshness평가도 reader완료 시각을 사용한다. 모든 단계 후 deadline실패를 정산한 다음 complete를 재시도하던 경로도 제거했다.
- 관련11파일147개/74.15초 pass. 테스트의 prefer-const2건 수정 후 신규12개/9.91초 재통과. backend build/typecheck/lint exit0, 제품 독립리뷰 필수결함0. 중복 비용 타입을 공유하여 pure248행/최대156자와 reviewability를 유지했다.
- 실제 compiled 제품5시나리오와 별도 Node4프로세스 인수를 완료했다. reader80.126ms/lease40ms에서 단계완료0, 다른PID의fence2 재획득→완료·digest재개방 일치; freshness5ms/reader80.115ms는stale. 예산실패의 허위완료ID0, 정상완료ID1. 주입reader·격리DB의 논리단계 검증이며 실제SB/업무일정운영이 아니다. 임시자원 제거 확인.
- 자동운영 연결 HOLD를 실제HTTP로 보강했다. 기존논리아침 완료 뒤 Today200/brief.no_data, 논리저녁 완료 뒤 Today500/INTERNAL_ERROR, GET DB쓰기0. 기존 generateMorningBrief·generateEveningCloseout/EveningCloseoutStore를 연결해야 하며 no_external_effect를 검증artifact로 받아들이는 우회는 하지 않는다.
- 근거/재개조건 `docs/planning/adr-daily-loop-runtime-results.md`. 증거루트의 daily-loop-product-*.log, daily-loop-process-product.json/log, daily-loop-result-product.log, daily-loop-activation-gap.mjs/json/log. 전체01–25/운영 인수 미완료, 기존 자동기억 원본차단 HOLD와 memory-store 큐 보류 유지. 운영DB/서비스/release/push 변경0.

## 2026-09-08 P1-12 선행 — 브리핑 공유 추천·출처·인용

- 직전 턴은 인계 계획 반영 확인으로 자비스 개발 기준 no progress였다. HEAD293c723과 현재 미커밋 파일을 재확인했다. 실제 브리핑 연결 대조에서 추천의 rank별 행동이 추천ID와 근거를 공유하지만 브리핑 parser가 전역 중복으로 거부하는 결함을 발견했다.
- 유효 digest의 공유 추천/출처/인용 입력3개 실패를 재현했다. record 간 추천·출처 및 동일 결합 인용의 공유를 허용하고 item/action·교차역할 충돌, record 내부 중복과 digest 검사를 유지한다. 같은 link의 다른 source/evidence는 거부하고 semantic 병합은 고유 link 기준으로 출력·예산을 계산한다.
- 관련6파일25개/8.30초 pass, 테스트 readonly 배열 matcher 수정 후 통합1개/reviewability2개/3.35초 pass(고유7파일27개). backend build/typecheck/lint exit0, 독립 리뷰 필수결함0. typecheck 초기 오류1개와 HTTP probe의 없는 summary 필드 오류를 보존하고 최종 재검증했다.
- 실제 compiled 비교: 이전 유효 입력21개 산출물 byte 동일. 실제 추천DB1개/행동3개·공유source1개·인용13회/고유7개를 그대로 유지한 fixture 입력은 이전parser 거부→새parser 수락, owner 브리핑1개 생성. 명시적 daily store저장2700bytes/재개방 동일, TodayHTTP200/degraded/item_count1/GET쓰기0, 임시자원 제거. 시험용 변환과 직접 저장이며 자동업무생산/예약handler 인수가 아니다.
- 설계/증거 `docs/planning/adr-morning-brief-shared-provenance.md`, 증거루트 `brief-provenance-*`. 우선순위 생산자·브리핑 parser/generator의 UTC today판정3곳을 확인했다. KST변경은 함께 구현·검증할 후속 범위이며 자동일일운영 HOLD는 실제handler/서명마감/출처차단/예약복구 연결 전까지 유지한다.
- 전체01–25와 운영 인수는 미완료다. 최신 전체gate는a4a2ebc이며 이번 결과는 단위 검증이다. 기존 자동기억 원본차단 HOLD와 memory-store 큐 보류 유지. 운영DB/서비스/release/push 변경0.

## 2026-09-08 P1-12 선행 — 서울 날짜의 우선순위·브리핑

- 직전cf4e9c8은 커밋·DB/HTTP 인수까지 완료한 progress였다. 재개 시 HEAD와 미커밋 상태를 확인했다. 일일루프는KST지만 우선순위/브리핑 두 소비자 총3곳이UTC날짜로 today를 판정하는 문제를15개 경계 중10fail로 재현했다.
- 세 지점에 기존 kstLocalDate를 재사용했다. overdue 우선·기한equality·경과시간7일 상한·UTC저장형식은 유지한다. KST/UTC자정, 월말/연말/윤일 및0000/0099/9999년 브리핑 날짜 비교를 검사했다. 새 결과는 경계에서 달라지며 과거 산출물의 재작성이나 승인 권한 변경은 없다.
- 관련6파일56개/3.63초, 추가13파일61개/40.70초: 고유19파일117개 pass. backend build/typecheck/lint exit0, 독립 리뷰 필수결함0.
- 실제 이전 compiled 추천1개/행동3개의 원본·조회·정확재시도 쓰기0 확인 후 probe의 미파싱 JSON context 오류로 중단됐다. 고정cf4e9c8의 engine/ranking2모듈로 동일 요청을 재생성하고 최초 요청과 deepEqual 검사, 다른프로세스 저장→현재코드 재개방으로 최종 인수를 완료했다. 기존추천byte/digest·행동3개보존/정확재시도쓰기0/새결과동일ID거부/TodayHTTP200/조회쓰기0.
- UTC/서울/Los_Angeles/Kiritimati4개 실제Node프로세스×4시나리오에서 ranking+brief canonical bytes 동일, 임시자원 제거. 설계·최초 probe실패·증거는 `docs/planning/adr-seoul-deadline-calendar.md`, 증거루트 `seoul-deadline-*`.
- 저장된 추천에는 원래 마감시각 전체가 없으므로 과거UTCbucket을 새브리핑에 그대로 연결하는 변환은 보류한다. 실제handler는 검증된 현재근거에서 기한을 확인해야 한다. 브리핑/서명마감의 처리기·출처차단·예약복구 연결 전 자동일일운영 HOLD 유지. 전체01–25 및 운영 인수 미완료, 최신전체gate a4a2ebc, 운영DB/서비스/release/push 변경0.

## 2026-09-08 P1-12 선행 — 일일 폴링과 중단 실행 복구

- 직전 인계 확인 턴은 자비스 제품 기준 no progress였다. HEAD `6e340c0`과 작업 트리, 기존 테스트 handle의 exit0 및 9개 통과를 확인하고 미커밋 복구 변경을 이어갔다. 다른 작업의 AGENTS·인계 문서와 미추적 산출물은 이번 커밋 대상에서 제외한다.
- 성공한 startup/cycle의 관측 시작 시각부터 다음 poll 사이의 아침·저녁을 복구한다. 실패 시 커서 유지, 시계 역행 시 최대 시각 유지, 설정된 최대31일 lookback을 적용한다. 활성 lease·기한 만료·차단된 실행은 due에서 제외하고 만료 lease의 미완료 실행을 발견한다.
- 초기 경계9개 중8fail, 리뷰 경계5개 추가 시9pass/5fail, legacy verifying 재개1fail을 재현했다. startup의 만료 실행 재진입과 drain 실패·지연 이후 복구 창 우회를 수정했다. 자동 claim에서 pending 일정의 창을 원자적으로 검사하며, 수동 claim과 실행 중 stale lease 오류 전파는 유지한다.
- 기존 claim을 별도 모듈로 분리했다. legacy verifying은 완료 단계와 기존 tail 검사를 거쳐 completed만 추가하며 원래 checkpoint를 보존한다. 기존 다음날 poll 기대값1개는 이제 기록되는 전날 저녁의 failed/MISSED 상태를 phase·failure_code로 명시했다.
- 최종 관련13파일163개/73.17초 pass, backend build/typecheck/lint exit0, 독립 정적 리뷰 잔여 필수 결함0건. 최초 실패와 중간 검증은 증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의 `daily-poll-*.log`에 보존했다. 전체 verify 결과는 아니다.
- compiled API와 실제 Node5프로세스 인수: 실제80.327ms 지연으로 건너뛴 일정 완료1개·반복쓰기0. 단계1개 저장 후 SQLite를 연 채 SIGKILL, 다른PID의 cycle이 fence2로 복구하여 완료1개·이전 단계/checkpoint bytes 보존·DB 재개방 일치. 별도 SIGKILL 실행은 deadline 시점 startup에서 완료0개·원래 run 보존·오류0. 임시 디렉터리 제거 확인. 근거 `daily-poll-live.mjs/json/log`.
- 임의 MorningBriefInput을 받는 자동 저장 API는 HOLD다. 자체 digest와 알려진 추천ID만으로 본문·출처의 진위를 증명할 수 없고, quarantine도 lineage 존재로 반환될 수 있다. 검증된 추천 action·현재 근거 mapper, 모든 parent 검사, 상속 후 가용성 검사와 원자적 artifact/lineage 저장이 선행 조건이다. 상세 `docs/planning/adr-daily-poll-recovery.md`.
- 이번 인수는 개발 API의 논리 단계다. 실제 브리핑·서명 마감 처리기, 일일 총량 예산, 예약 서비스, retention 및 전체01–25 운영 인수는 미완료다. 기존 자동기억 원본차단과 memory-store 큐 HOLD 유지. 운영DB·서비스·release·push 변경0.

## 2026-09-08 P1-12 선행 — 추천 읽기의 원본 결합

- 직전 `67d9ccc`는 수정·검증·커밋까지 완료한 progress였다. 재개 시 해당 HEAD와 기존 소유자 변경을 확인했다. 브리핑 mapper 입력을 추적하면서 storedRecommendationIdentity의 재해시 비교 누락, 행동/metadata 원본 대조 누락, 개인 reader의 문자열 source_version 판별을 확인했다.
- 최초16개 중11fail/5pass. 기존 canonical/evidence hash로 대조하고 추천 ID·metadata·rank별 행동을 공통 검증한다. material은 ranking rank→action ID로 결합하여 역순 제출을 보존한다. 개인 reader는 파싱된 버전으로 task18과 legacy를 구분하며 과거 ranking은 재계산하지 않는다.
- 독립 리뷰의 두 연결 snapshot 불일치2fail을 재현했다. projection·개인 reader·timeline/context 전체를 deferred transaction으로 묶었다. 복원 fixture가 다른 rank 제목도 바꾸던 오류1개를 수정했으며 공개 API의 검증과 반환은 같은 snapshot을 사용한다.
- 관련 계약과 workflow·승인·실행기 및 최종 신규 검사에서 고유18파일152개 pass. backend build/typecheck/lint exit0, 최종 독립 정적 리뷰 필수 결함0건. 초기 branded ID 타입 오류3개와 snapshot fixture 실패를 원장에 구분해 보존했다.
- 실제 이전/현재 compiled 두 프로세스의 같은 DB에서 정상 조회5종 canonical bytes 동일, 읽기쓰기0. 이전에는 변조 제목을 정상 반환했으나 현재 HTTP 추천 상세는 정상200·변조500·본문 표식 노출0이다. 임시 디렉터리2개 제거 확인.
- 검증 추가 비용을 측정했다. 추천100개/행동300개·12회·limit500의 p50 49.918→73.481ms, p95 61.547→95.119ms, 결과bytes 동일·쓰기0. 성능 개선으로 분류하지 않는다. 상세/실패/실행 증거는 `docs/planning/adr-recommendation-read-binding.md`와 증거 루트의 `recommendation-read-*`다.
- source 생산자·정책/생성 시각의 의미 및 context evidence·실제 본문·절대 기한을 검증하는 mapper는 미완료다. 브리핑 자동 저장·일일 운영 활성화 HOLD 유지. 전체01–25/운영 인수 미완료, 운영DB·서비스·release·push 변경0. 공통 읽기 변경의 전체 소비 경로를 확인하기 위해 커밋 후 canonical verify를 실행한다.

## 2026-09-08 P1-12 선행 — 관측 신뢰도 입장 조건

- 직전 턴은 실제 compiled DB의 trust4종과 근거 유형 불일치를 재현해 다음 수정을 확정한 progress였다. 이번 재개 시 verify 세션33785가 live임을 직접 확인하고 같은 handle을 종료까지 추적했다. 실행 중 tracked 소스는 유지하고 외부 cache에 회귀·과거 DB 재개방 준비를 진행했다.
- `010281c` 전체 verify exit0: backend398파일2606개(1321/554.52초+1285/589.38초), dashboard32파일187개/28.73초. runtime/lint/typecheck/build/고정시각 acceptance/CLI smoke exit0. 실행 전후 HEAD 동일, tracked 바이트 변경0. 증거 `verify-010281c-{before,after}.json`, `verify-010281c.log`.
- 조립기의 Linux live_task 선택에 payload.trust=verified를 요구한다. user_confirmed/inferred/untrusted는 critical UNVERIFIED_SOURCE omission으로 남기며 정상 관측과 함께 있어도 abstain한다. 기억의 user_confirmed 기준과 기존 비Linux·비task·stale 우선순위는 유지한다. 라벨 검사 자체가 원본 진위나 실행 권한을 증명하지 않는다.
- 신규11개 red6fail/5pass 후, 관련9파일42개/17.13초 pass. 타입/lint/backend build exit0, 최종 독립 정적 리뷰 필수 결함0건. 리뷰에서 추가된 Mac host·freshness equality 반례를 포함했다. 증거 `context-source-trust-*.log`.
- 실제 compiled DB 저장에서 verified만 sufficient/allow·관측1/근거2, 나머지3종은 insufficient/abstain·관측0/근거1을 확인했다. 다른 프로세스의 과거 DB 재개방은 원본 row와 정상 verified 결과 bytes 동일·정확 replay 쓰기0·새 inferred 문맥 새ID/insufficient를 확인했다. 시험 루트3개 제거/잔여0. 증거 `context-source-admission-*`, `context-source-history-*`.
- 조립기 근거 유형과 추천의 역할별 근거 유형이 다르며 정책 ContextFact는 verified를 지원하지 않는다. reference_only 기억을 원칙/승인으로 승격하거나 과거 deadline bucket을 재사용하는 자동 연결은 HOLD다. 실제 분류·절대 기한 보존→생산자→원자적 lineage 저장→서명 마감→service/retention 순서와 근거를 `docs/planning/adr-context-source-admission.md`에 기록했다.
- 이번 변경의 검증은42개와 compiled DB 경로다. 전체gate는 변경 전010281c이며 전체01–25와 운영 인수는 미완료다. 기존 자동기억 원본차단 및 memory-store 큐 HOLD 유지. 운영DB·서비스·release·push 변경0.

## 2026-09-08 P1-19 선행 — 백엔드 빌드 식별 생산자

- 직전 인계 확인 턴은 수신 문서 반영 확인이었고 자비스 개발 기준 no progress였다. 재개 시 HEAD ba27291370cb504d434b1e64882b1de180031f6f와 미커밋 빌드5파일을 확인했다. 이전 테스트 handle29895의 exit0/10pass를 회수하고 현재 소스에서 검증을 이어갔다.
- 기존 빌드에 소유 시험파일을 넣어 삭제 소스의 JS 잔여가 남는 것을 재현했다. 새 wrapper는 별도 컴파일→입력 재대조→backend 네 디렉터리 교체→산출물 재대조→manifest 마지막 게시를 수행한다. HEAD/dirty/입력·산출물·마이그레이션 digest 및 toolchain을 기록한다.
- 앞선 독립 리뷰에서 빌드 경합의 타 빌드 출력 손실, 복원 실패 후 backup 삭제, metadata 정리 실패로 rollback 생략의3개 결함이 지적됐다. SQLite EXCLUSIVE lock, 개별 복원 실패 시 recovery_root 보존, metadata 정리와 rollback 분리로 수정했고 실제 compiler/process·오류 주입10개로 검증했다.
- 현재 소스10개/5.52초 pass, 실제 backend build/lint/typecheck/CLI smoke/fixed-clock acceptance exit0. actual build 파일1,044개/6,002,823bytes, 별도 해시 대조 일치. 격리 compiled AuthorityDb에 적용한70개 migration journal과 manifest ID/checksum/vector 일치, dashboard4개 bytes/mode 보존, stale 시험파일 제거, staging잔여0, 시험DB디렉터리 제거 확인.
- 소스 HEAD ba27291/dirty=true에서 artifact digest는 sha256:12ee56423236d191a635cd3be6a773937e5c94e4f8daa0c783f9c3cd018c5480이다. 입력 digest와 Git dirty는 별개이며 이 결과를 clean release로 표시하지 않는다. 증거 `build-identity-*.log`, `build-identity-live.mjs/json`, 설계 `docs/planning/adr-backend-build-identity.md`.
- 독립 fresh review `/root/review_backend_identity`는 ship/필수 결함0건으로 완료됐다. 요청 모델/effort는 gpt-5.6-terra/high, 실제 설정·개별 token usage는 도구에 노출되지 않았다. native better-sqlite3를 빌드 lock에도 요구하며 hardkill 중 여러 디렉터리의 crash-atomic 전환을 보장하지 않는다. runtime/UI·실제 schema 대조·운영 적용·전체01–25는 미완료다. 기존 자동일일운영/자동기억 원본차단/memory-store 큐 HOLD 유지. 운영DB·서비스·release·push 변경0.

## 2026-09-08 P1-19 후속 — 현황판 서버·DB 식별 표시

- 직전ae23366은 빌드 생산자 구현·실제 산출물/DB 대조·커밋으로 progress였다. 현재 HEAD와 기존 비소유 변경을 확인한 뒤 ADR에 후속 조회 계약을 기록했다. 모듈 상대 root의 manifest/file 대조를 서버 초기화 시 보존하고 overview.runtime과 현황판의 펼치기 영역을 연결했다.
- 시작 당시 파일 일치/불일치, 기록 없음/오류/읽기 실패, 소스SHA·dirty·입력/산출물digest·Node/ABI·PID/시각을 구분한다. GET에서 checkout을 조회하지 않으며 DB 재개방은 새 연결을 사용한다. DB migration ID/checksum 누락/추가/변경과 실제 sqlite_schema 객체수/digest를 각각 계산한다.
- 중복 migration ID가 있는 재생성 원장의 matched 오판정1fail/15pass를 재현하고 unavailable로 수정했다. lint 제어문자 정규식 오류1개도 수정했다. 최종 backend6파일33개/15.57초, dashboard33파일190개/30.19초 pass, build/typecheck/lint/CLI smoke/fixed-clock acceptance exit0. 전체 verify 결과는 아니다.
- 실제 built HTTP+Chromium127.0.0.1:37809/overview: 시작 파일1,049개/70migration 일치, PID2076416/ae23366/dirty=true. 실제 시험DB에 migration1개 추가→unexpected1/API mismatch→SSE후화면 차이 표시. 테이블1개 추가→구조1,359→1,360/hash변경, journal은별도matched. 원복 후 시작관측·구조hash 동일, GET쓰기0, 시험디렉터리 제거.
- 1440×1000/390×844 정보 펼치기·SHA·dirty·DB 표시, 가로넘침0, component axe serious/critical0, console/pageerrors0. Browser plugin not available로 Playwright 사용. 초기axe는newContext부재로실패하여 probe 수정 후 통과했다. 스크린샷 직접 확인, 증거runtime-identity-live.mjs/json 및runtime-identity-*.png/log.
- compiled 상태읽기30회 p50 3.527ms/p95 4.811ms·schema1,359개·쓰기0. 신규 계산비용이며 기존대비성능향상으로표현하지않는다. 운영daemon별도release·CLI연결·현재디스크재관측·정상schema기준선·운영인수는미완료다. UI는초기화시디스크관측/마이그레이션기록대조의한계를명시한다. 전체01–25활성, 기존HOLD유지, 운영DB·서비스·release·push변경0.
- 첫 독립 리뷰 review_runtime_identity는 fix-first/필수1건(API optional runtime 검증누락)이었다. malformed14종 red14fail/4pass 이후 guard 추가, 최종 dashboard33파일205개/34.75초 및 build/typecheck/lint 통과. 실제 browser malformed200응답→기존오류화면→정상응답복구, 두viewport·쓰기0·콘솔0 재확인. 최종경로127.0.0.1:41041/PID2130213, 초기화31.897ms이며 앞선 관측과 구분한다.
- 최종fresh review_runtime_identity_final은 ship/필수0건. 요청gpt-5.6-terra/high, 실제값native미노출·리뷰어GPT-6표기는자기보고다. 중간probe route.fetch/reload경합의 Route already handled를 고정응답fulfill/unroute대기로해결했다. 잔여소유시험디렉터리1개는열린FD사용자0 확인후제거했다. 최종시험루트잔여0. 커밋후전체canonical verify를실행하며 결과확인전완료라고표시하지않는다.

## 2026-09-08 P1-12 — 아침 원본 생산자와 원자적 게시

- 인계 확인 턴은 자비스 개발 기준 no progress였다. 재개 시 active worktree의 HEAD4f6f35e와
  미커밋 게시/Today 변경을 확인했다. 기존 verify handle67582는 종료 상태였으며 wrapper
  기록은55d2e3e 전후HEAD/추적바이트 동일, exit1이다. 첫 shard1417pass/2fail,
  둘째1435pass. 실패2건 모두 cancellation-intent의163자 줄로,4f6f35e가 줄바꿈만 수정했다.
  이후 동일 형식 gate2파일4개 통과. 전체 verify 통과로 보고하지 않는다.
- MorningRecommendationSource0097abb는 저장 추천·문맥·현재 절대기한 근거를 검증해
  브리핑을 생성한다. cycle IPC readiness e96e401은 socket 파일 존재 대신 listener 준비
  메시지를 기다린다. 두 변경은55d2e3e에 통합돼 있다.
- 게시765565e: IMMEDIATE transaction 안에서 현재 추천을 재조회하고 lease/날짜/실제
  선행 단계/바이트/마지막 유효시각을 검사한다. 병합된 모든 추천·문맥·행동 계보를
  daily_run/daily_step/morning_brief와 원자적으로 저장한다. 두 번째 출처 삭제도 차단된다.
- 최종 게시/조회/형식4파일23개 통과. lint/typecheck/build exit0. 실제2Node 재검증에서
  정상6후보/2출처, 잠금 전 삭제경합 후3후보/1출처, 병합항목1개·읽기쓰기0을 확인했다.
- fresh reviewer /root/morning_publisher_review는ship/지적0건. 요청sol/high,
  실제모델·effort미노출. reviewer 테스트는infra write -122로0개 실행됐으므로 부모의
  통과 로그를 사용한다. 별도 외부리뷰 비용/결과는 자체보고이며 native 토큰 실측으로 합산하지 않는다.
- 증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`: verify-morning-source-integrated*,
  morning-publisher-accepted*, morning-publisher-final-live.log, morning-publisher-live.mjs/json.
  초기검증과최종검증은중복이있어합산하지않는다. 고정시각acceptance/CLI smoke도exit0.
- 자동 identity충돌 병합, generic lineage전면교체, provider fence, 실제일일총량장부,
  아침/저녁/retention서비스활성화는미완료·HOLD다. 임의본문게시HOLD는검증된원본을
  이게시API로처리하는로컬경로에한해해소한다. 전체01–25와운영인수목표유지.

## 2026-09-08 P1-12 — 기존 일일 루프의 실제 아침 실행기

- 직전 인계 확인 턴은 자비스 개발 기준 no progress였다. 재개 시 codex/morning-source의
  HEAD b2e11a9와 미커밋7파일을 확인했다. 종료된 검증 handle36912/11907을 회수했다.
- createStoredMorningDailyLoop가 기존 prepare/claim/recover/finish에 refresh reader와
  MorningBriefPublisher를 연결한다. 같은 날짜의 완료 원장으로 items/work/bytes를 집계하고
  예산 초과 시 해당 게시와 계보를 원자 rollback한다. 삭제·격리로 사용량을 환불하지 않는다.
- 앞선 리뷰의 최종 완료 시계 역행을 실행기 complete와 공통 monotonic clock으로 보강했다.
  새 event 이력 테스트의 잘못된 준비 입력은 공개 prepare 경로로 수정했다.
  임시경로 write -122로 최초0개 실행 후 별도 TMPDIR에서 최종3파일24개/16.08초통과.
  lint/typecheck/backend build/fixed-clock acceptance/CLI smoke exit0.
- 실제 compiled3프로세스 PID3508902/3508909/3508932: refresh 저장 후 SIGKILL,
  다음PID의cycle에서 완료1·refresh1·재실행쓰기0·조회쓰기0·사용량2/2/3440.
  KST07:15 전후 빈DB cycle은 완료1·no_data·refresh1·재실행쓰기0·사용량1/2/754.
  고정시각 시험DB의 실제 프로세스 검증이며 운영daemon 실행 증거는 아니다.
- 독립검토 /root/daily_morning_final_review: 운영 caller가 없는 전체 목표 기준 fix-first,
  중간 개발 단위 범위 재확인 후 ship/추가 코드 결함0건. 요청terra/high, 실제 설정미노출.
  전체일일운영완료로표시하지않고 서비스caller·실제event·서명저녁·retention·provider fence와
  사용량/운영정책 연결을 필수 다음 단계로 유지한다. 자동운영 HOLD와 전체01–25 유지.
- 이전 b2e11a9 전체verify:1420pass/1fail +1450pass, exit1, 전후HEAD/추적바이트동일.
  실패는 정정 proof_signature fixture 준비 중 MEMORY_OLD_DATABASE_FD_ACTIVE다.
  같은 테스트 단독11통과 및 compiled8회 진단 모두 old fd_count0/예정INTERRUPTED에
  도달했으나 원인미확정이다. guard완화0. 반복진단/집중시험을 전체gate통과로대체하지않는다.
- 증거 /home/jm/.cache/jarvis-test-runtime-qa-20260908/daily-morning-complete-*.log,
  correction-old-fd-diagnostic.mjs/json/log, verify-morning-publication-after.json.
  개발단위커밋만수행하며 운영DB·서비스·release·push변경0.

## 2026-09-08 P1-12 — 아침 실행 CLI와 권한 기반 완료 응답

- 직전465ec00은 아침실행기커밋과실프로세스검증으로 progress였다. 해당트리의전체검증
  handle61181은실행중임을확인했으며소스를고정했다. 종료된이전검증트리
  codex/priority-deadline-evidence를465ec00으로ff해이후변경을격리했다.
- 이전465ec00의전체npm run verify는exit0: backend1434+1450통과/dashboard248통과,
  runtime/lint/typecheck/build/고정시각acceptance/CLI smoke통과. 전후HEAD/추적바이트동일.
  이전b2e11a9의oldFD실패기록은유지하며재현원인을확정했다고표시하지않는다.
- `daily morning --once --db PATH --input CONFIG`가기존startup/claim/finish를호출한다.
  명시적DB·닫힌8192byte설정·프로세스UUIDowner·실제사용량응답을연결했다. 새로운스케줄러나
  타에이전트실행경로는추가하지않았다. GJC coordinator 경로와운영서비스는변경하지않는다.
- 아침조립은morning/현재KST날짜만자동생성·복구·claim하며타phase event_source를drain하지않는다.
  자정넘는복구창에서전날브리핑claim→STALE_LEASE를1fail/8pass로재현후과거pending일정을
  missed로기록하도록수정했다. 일반루프의전체phase/날짜복구는보존한다.
- 초기예정시각/생성시각충돌가설은분류기의정확시각조건으로성립하지않아변경을철회했다.
  초기7파일123통과뒤lint미사용변수3건을수정했다. 모듈255행제한위반은일정/단계정의를
  기존daily-loop-schedules로옮겨서비스238행으로정리했다. 이후7파일124통과.
- 첫fresh검토 /root/daily_morning_cli_review는fix-first/2건: suppression된완료와
  active/uncertain/expired run을ok=true로보고했다. 추가6red/9pass후정확run/step/brief의
  privacy projection·무결성·완료·유효시각을한읽기snapshot에서검사하도록수정했다.
  실패는각typederror/exit2이며삭제된사용량의환불은하지않는다. 수정후7파일130통과.
- 응답중자정변경과저장완료전으로의시계역행도각1red로재현해날짜/updated_at검사추가.
  최종집중3파일32통과/21.31초, lint/typecheck/backend build/acceptance/CLI smoke exit0.
  넓은회귀와최종집중검증은중복이있어합산하지않는다.
- 최종실제CLI PID3743573/3743584/3743596/3743648/3743831/3743896/3743897:
  refresh commit후SIGKILL→새CLI완료1/재실행추가완료0/refresh행동일,
  저장추천브리핑항목1/사용량2·2·3440. 동시CLI완료run1/단계2. stale/hidden각exit2.
  별도예산실패CLI PID3744011/exit2/BUDGET_WORK_EXHAUSTED, refresh완료/morning미게시.
  고정시각preload/crash관측기가있는합성DB의실제실행파일검증이며운영인수증거가아니다.
- 현재refresh완료원본과provider fence는미연결이다. 출력provider_refresh=unavailable,
  automatic_operation=hold를유지한다. 서명저녁/event/retention/timer·서비스활성화 및
  전체01–25목표는계속미완료다. 기존guard·migration bytes를완화하지않았다.
- 증거 /home/jm/.cache/jarvis-test-runtime-qa-20260908/daily-morning-cli-final-*.log,
  daily-morning-cli-live.mjs/json, daily-morning-cli-failure-live.mjs/json,
  verify-morning-execution-after.json. 최종fresh검토 /root/daily_morning_cli_final_review: ship, findings 0.
  요청 gpt-5.6-terra/high, 실제 모델·effort는 도구에서 미노출.

## 2026-09-08 P1-12 — CLI 전체 검증 종료와 저녁 집계 연결

- 2f54516 아침 CLI 전체 npm run verify는 exit1로 종료했다. backend 1433+1467통과,
  memory-correction-control의 purge_digest 증거 손실 케이스1건은5초 timeout이다.
  해당 케이스만 같은 소스로 재실행하면3471ms/1pass10skip이었다. 원인은 미확정이며
  전체 실패를 집중 통과로 대체하지 않는다. 후속 dashboard/acceptance/smoke는 이 gate에서 미실행.
  전후HEAD2f54516/추적바이트동일. verify-morning-cli-after.json 및 log로 확인했다.
- 20f8345는 legacy 상태 로그의 시작 시각을 refresh 완료로 해석하는 오류 수정이다.
  readiness4파일86통과/정적검사/build 및 실제 합성 생산자2프로세스 인수, 독립검토ship.
- 5c2c0f7은 미래 서명 저녁 산출물 게시 거부다. 관련3파일21통과/정적검사/build,
  실제Node/SQLite/서명 PID3924180에서 거부쓰기0·시각경계성공, 독립검토ship.
- 저녁 사용량 집계는 외부 신뢰 키를 받은 경우만 기존 서명 검증과 run/date/correlation을
  확인한다. 완료 단계 실제항목/작업/UTF-8바이트를 집계하고 후보ID를 support와 중복 계수하지 않는다.
  최종관련2파일23통과/정적검사/build, 실제PID3957933의5/1/3636 확인. 운영 원본은 합성이다.
- 실제 저녁 원본·신뢰 키 공급·원자 예산 게시·일일 실행기·retention·timer 및 전체01–25는
  계속 미완료다. provider refresh 완료 계약과 자동 운영은 보류한다.
- 전체 gate 종료 뒤 고정2f54516에서 건너뛴 검사를 별도로 실행했다. dashboard35파일248통과,
  고정시각acceptance와CLI smoke exit0(handle83756 종료). 전체 gate의 timeout 실패는 유지한다.
  증거 morning-cli-downstream-{dashboard,acceptance,smoke}.log.
- 저녁 사용량 최종독립검토 /root/evening_usage_review: ship, 지적0. 요청luna/high, 실제설정미노출.

## 2026-09-08 P1-12 — 저녁 집계 전체 검증 및 후속 경계

- 고정 HEAD `12c424feed4ec560e68954c78e75ccca5a79aa0c`의 `npm run verify`가 exit 0으로 종료했다.
  backend 213+213파일, 1435+1473=2908개 통과; dashboard 35파일 248개 통과.
  전후 HEAD 동일, 변경 추적 파일 0개, 추적 파일 바이트 동일이다.
  증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-evening-usage.log`와
  `verify-evening-usage-after.json`. 이전 `2f54516` timeout 원인 해소까지 증명하지는 않는다.
- 후속 커밋 `aef39a2`는 저녁 게시와 일일 예산 검사를 한 트랜잭션으로 묶었다.
  `6272f3a`는 Today 저녁 완료 표시에서 산출물 자체 공개키를 신뢰하던 경로를 제거했다.
  각 단위 검증과 독립 검토 결과는 `adr-evening-budget-settlement.md` 및
  `adr-closeout-dashboard-trust.md`를 따른다. 위 전체 검증에는 두 후속 커밋이 포함되지 않는다.
- 실행 진입점 `src/dashboard/main.ts`를 확인했다. `createDashboardServer`에 추가된
  `trustedCloseoutKey`를 CLI에서 구성하는 경로는 아직 없다. 미설정은 완료 표시를 숨기는
  현재 계약을 유지하며, 실제 공개키 공급과 실제 저녁 원본·실행기 연결을 후속 개발한다.
- 운영 배포·재시작은 수행하지 않았다. 합성 자료의 프로세스 검증과 실제 운영 인수는 구분한다.

## 2026-09-08 — 저녁 신뢰 변경 전체 검증과 원본 작업 증거

- 고정 `73e1a946c70fc970b48d369d1214c16fa757d791`의 전체 `npm run verify`는 exit 0.
  backend 213+213파일에서 1438+1477=2915개 통과, dashboard 35파일248개 통과.
  전후 HEAD 동일, 변경 추적 파일 0개, 추적 바이트 동일.
  증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-evening-trust-after.json` 및 log.
- 후속 `6eba951`: 대시보드 CLI에 외부 저녁 검증 공개키 설정을 연결했다.
  `99d6e44`: 과거 완료 조회에서 손상된 인증 원본 바이트를 거부한다.
  `885c42c`: 원래 native 작업 서명을 유지하며 완료 시각·현재 신뢰·취소를 확인하는
  내부 증거 조회를 추가했다. 이 세 커밋은 위 고정 전체 검증에 포함되지 않는다.
- 원래 작업 인증과 저녁 v1 인증의 서명 도메인이 다르다. 서명을 옮겨 붙이거나
  합성 재서명으로 대체하는 연결은 HOLD. native 증거를 보존하는 저녁 출력 계약,
  공개 범위·삭제 계보·생산자·스케줄 연결은 계속 미완료다.

## 2026-09-08 — native Today 전체 검증과 저녁 실행 연결

- 고정 `0274c46a2fd52cbe09375dcb80aedcda3f2332ec`의 `npm run verify`가 exit 0으로 종료했다.
  backend 214+213파일, 1448+1486=2934개 통과; dashboard 35파일 248개 통과.
  전후 HEAD 동일, 변경 추적 파일 0개, 추적 바이트 동일이다.
  증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-native-today.log` 및
  `verify-native-today-after.json`. 이전 fa1a46d 검증의 exit143 원인은 확인되지 않았다.
- `bc0c4e1`은 Today에 신뢰된 native 보고서를 연결했고 `a0fa93b`는 행 길이 제한을 수정했다.
  `0274c46`의 Chromium 회귀는 1440/1024px에서 완료 1건 표시와 원본 격리 후 새로고침에 따른
  보고서 제거를 확인했다. 작업 인증·기억 출처는 합성 fixture이며 운영 에이전트 인수가 아니다.
- 후속 `6d58264`는 기존 일일 루프의 전용 저녁 실행기다. 서명 전 claim·단계·격리를 검사하고
  native 저장 경계에서 보고서와 실행 완료를 원자적으로 처리한다. 관련 12개 테스트 및
  빌드·lint·타입 검사 통과, 두 Node 프로세스에서 재시작 후 발행 1건·중복 서명 0회를 확인했다.
  이 후속 커밋은 위 전체 검증에 포함되지 않는다.
- 저녁 CLI·운영 서명 키 공급과 서비스 연결, 실제 기억 출처 admission, 나머지 저녁 섹션,
  provider refresh 완료 계약, retention 및 원래 01–25 목표는 계속 진행 중이다.

## 2026-09-09 — native CLI 전체 검증

- 고정 `3f7b58fc4fca202f4225fec0b1f7d90c958d9076`의 전체 `npm run verify`가 exit 0으로 종료했다.
  backend 215+214파일, 1459+1496=2955개; dashboard 35파일248개 통과.
  전후 HEAD 동일, 변경 추적 파일 0개, 추적 파일 바이트 동일이다.
  증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-native-cli-after.json` 및 log.
- 후속 `1beee0c`의 systemd 후보 설정과 `d403db5`의 임시 유닛 실측은 위 고정 검증 범위 밖이다.
  실제 저녁 시각의 보고 발행·timer 지속성·실제 출처 연결은 계속 HOLD다.

## 2026-09-09 — 부모 계보 변경 전체 검증

- 고정 `f9da7fb32aba2dd6d1756f6a2c6ea2875b38df10`의 `npm run verify`는 exit 0.
  backend 215+215파일, 1459+1505=2964개; dashboard 35파일248개 통과.
  전후 HEAD 동일, 추적 파일 변경 0개, 추적 바이트 동일.
  증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-parent-lineage-after.json` 및 log.
- 이후 순회 제한 `738db67`과 게시 경계 `7d664b8`은 이 고정 전체 검증에 포함되지 않는다.
  각 관련 테스트와 별도 프로세스 검증은 해당 ADR에 기록했다. 실제 출처 admission과 운영
  자동화, 게시 후 삭제는 계속 미완료이며 합성 테스트를 운영 완료로 간주하지 않는다.

## 2026-09-09 — retention 운영 연결의 잔여 계약

- `src/personal-os-runtime.ts`의 `forServiceRun`은 GJC 서비스와 retention 객체를 생성하지만
  retention 어댑터를 전달하거나 작업 생성·claim·실행을 호출하지 않는다. 일일 운영 연결(12)은 미완료다.
- migration 036은 notification_intents 삭제를 금지한다. migration 032는 personal_observations의
  수정·삭제를 금지하며 personal_source_checkpoints와 personal_context_observations가 관측 행을
  참조한다. 두 데이터 클래스를 단순 DELETE 어댑터로 연결하는 변경은 HOLD다.
- 후속 구현은 보존할 최소 증거와 지울 내용의 경계, 참조 및 체크포인트 처리, 정정·삭제 계보,
  재수집 멱등성, 운영 정책 승인을 함께 해결해야 한다. 기존 migration bytes를 바꾸거나 트리거만
  제거해서 운영 완료로 처리하지 않는다. privacy-security 문서의 30일 관측/7일 알림 보존 규정 자체는
  현재 스키마에 대한 삭제 실행 경로를 제공하지 않는다.

## 2026-09-09 — 상태 게시 경계 전체 검증

- 고정 `b491472a767dae1f09c5399837299f267e091121`의 전체 `npm run verify`는 exit 0.
  backend 217+216파일, 1466+1510=2976개; dashboard 35파일248개 통과.
  전후 HEAD 동일, 추적 파일 변경 0개, 추적 바이트 동일.
  증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-state-publication-after.json` 및 log.
- 후속 retention 재claim `baee397`과 cutoff 고정 `379bc6d`는 위 전체 검증에 포함되지 않는다.
  각 단위 검증 및 별도 프로세스 결과는 해당 ADR에 기록했다. 운영 활성화 및 전체 01–25
  목표가 완료됐다는 의미는 아니다.

## 2026-09-09 — retention 정책 전체 검증과 아침 일정 후보

- 고정 `a101bb31ccac1885476d6152bff21d7f216b7d01`의 전체 `npm run verify`는 exit 0.
  backend 217+217파일, 1466+1519=2985개; dashboard 35파일248개 통과.
  전후 HEAD 동일, 추적 파일 변경 0개, 추적 바이트 동일.
  증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-retention-policy-after.json` 및 log.
- 후속 `da86809`는 아침07:15 systemd 후보와 격리 실행 기록이다. 실제 임시 서비스의
  최초완료1/재실행추가0/잘못된설정exit2, 시험타이머→CLI 완료1/exit0을 확인했다.
  시계 주입·빈 시험DB·경로 재지정을 사용했다. 운영 설치·실제 출처·지속복구는 HOLD다.
- 현재 라우팅 preview 작업은 이 고정 전체 검증 밖이며, 분류 자체를 실행자 준비나
  업무 완료로 취급하지 않는다. 전체 01–25의 미완료 범위는 유지한다.

## 2026-09-09 — 실행자 등록부 및 응답 바이트 보존

- `0878e0d`는 기존 Claude 실행자를 컴파일 등록부에 연결했다. 준비 상태와 승인 실행은
  계획의 provider를 정확히 조회하며 미등록 provider로 대체하지 않는다. CLI 등록부 조회는
  DB 생성·모델 호출 없이 설정 존재 여부만 반환한다. 30개 테스트, 빌드/lint/typecheck exit 0.
  상세 범위 및 읽기 전용 리뷰 ship은 `docs/planning/adr-task-executor-registry.md` 참조.
- 후속 계약 조사에서 Claude stdout의 손상된 UTF-8이 대체 문자로 변환되어 반환되는 결함을
  실제 로컬 하위 프로세스로 재현했다. ff/overlong/surrogate/truncated 4종이 수정 전 반환되어
  거부 테스트 4개 실패, 정상 Unicode 1개 통과였다. JSON 파싱 전 UTF-8 왕복 바이트 비교를
  추가해 원본과 불일치하면 TASK_PROVIDER_RESULT_INVALID로 거부한다.
- 수정 후 5개 파일 41개 테스트 통과(14.09초), backend build/lint/3개 typecheck exit 0.
  중간 빌드는 bytes 변수 충돌 TS2322로 실패했고 raw로 변경 후 위 검증을 재실행했다.
- 별도 컴파일된 전송 경로의 로컬 fixture 실행 PID1273195/exit0: 손상 응답 거부,
  정상 `한글 🧠 �` 원문 보존, 출력 바이트 101. 영수증:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/provider-utf8-zcFGQn/receipt.json`.
  실제 모델 인증·호출 또는 운영 적용 검증은 아니다.
- 실행자 입력/결과 형식 및 제한값 공통화, 인증 상태, 승인에 연결된 라우팅은 미완료다.
  동시 실행 중인 e70d113 고정 전체 검증은 위 두 후속 변경을 포함하지 않는다.
- 읽기 전용 `/root/provider_utf8_review`: ship, 지적 0개. 요청 luna/high,
  실제 모델/추론 수준 메타데이터 미노출. 비교용 추가 버퍼는 기존 출력 상한 1MiB 이내다.

## 2026-09-09 — 라우팅 preview까지의 고정 전체 검증

- 고정 HEAD `e70d11348510fd910e8bb406ed6e4d8acc286cbb`의 `npm run verify` exit 0.
  backend 218+218파일, 1481+1527=3008개 통과. dashboard 35파일248개 통과.
  canonical gate의 lint/typecheck/build/acceptance/CLI smoke를 포함한다.
- 검증 전후 HEAD 동일, 추적 파일 변경 0개, 추적 바이트 동일, 종료 시 추적 변경 없음.
  증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-work-routing-after.json`
  및 `verify-work-routing.log`, 프로세스 handle56819 종료 코드0.
- 후속 등록부 `0878e0d`, UTF-8 응답 수정 `8eb9ca4`, 자원 제한값 공통화는 이 실행에
  포함되지 않는다. 각 변경의 단위/실프로세스 검증을 전체 검증으로 확장해서 주장하지 않는다.
  운영 적용 및 원래 01–25 전체 목표는 아직 완료되지 않았다.

## 2026-09-09 — 실행자 등록부·바이트 검증·공통 제한까지 고정 전체 검증

- 고정 HEAD `8b98cd864ef9cde99fef7828223ba5a1d8da14d7`의 `npm run verify` exit 0.
  backend 219+219파일, 1486+1532=3018개 통과. dashboard 35파일248개 통과.
- 검증 전후 HEAD 동일, 추적 파일 변경 0개, 추적 바이트 동일.
  증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-executor-contract-after.json`
  및 `verify-executor-contract.log`, 프로세스 handle49273 종료 코드0.
- 이후 입력 계약 검사 `69782a7`, 로그인 상태 조회 `653ea36`, 대시보드 준비 경계
  공통화는 이 고정 실행에 포함되지 않는다. 업무 템플릿 3종의 설계와 남은 수용 조건은
  `docs/planning/adr-approved-task-templates.md`에 기록했다. 원래 01–25 목표는 미완료다.

## 2026-09-09 — 승인 기반 업무 템플릿 3종

- code-fix / incident-report / technical-review v1을 기존 workflow.start 및 task.execute에 연결했다.
  CLI catalog/compile 결과의 템플릿 정의 digest·파일 범위·검증 명령을 최초 승인 입력에 저장한다.
  템플릿이 있는 workflow는 staging부터 TaskSpec 요구사항을 검사하며, generic execution 경로도
  파일 범위 변경·필수 검사 삭제를 거부한다. 승인 후 입력 변경은 기존 immutable trigger가 차단한다.
- 보고서는 원본 읽기 전용·출력 1개다. 고정 sandbox 검사로 JSON 구조와 원문 인용을 확인한다.
  보고서 판단의 사실성이나 장애 해결을 인증하는 기능은 아니다. 자동 조치·기억 승격은 보류다.
- 최종 backend build + 55 tests/5files(29.88s) + lint + 3typechecks exit0(handle44584).
  세 템플릿 모두 fixture 생성→실제 sandbox→인증→Git 결과→완료 및 replay를 통과했다.
  옵션 형태 출력 경로의 Node --help 우회를 exit0/24861bytes로 재현하고 -- 구분자로 수정했다.
- 최종 실제 Claude1/별도 Node verifier1, 36614ms, 격리 결과 commit
  `b0ca897e9b8a5c4669c17fd960a5df91d6e18aff`; 준비 DB 변경0, 원본 HEAD/status/source 보존,
  완료 재호출의 추가 모델/검증기 호출0·ref 변화0. 시험용 서명 승인 키와 DB를 사용했다.
- 별도 built HTTP: preview200/create202 pending/잘못된 revision400, 거부 DB 변경0.
  전체 증거·인터페이스·검증 한계는 `docs/planning/adr-approved-task-templates.md` 참조.
  대시보드 선택/결과 표시, 실제 운영 입력·승인, 보고서 판단 평가 및 전체 01–25 목표는 남아 있다.


## 2026-09-09 — 항목24 템플릿 화면과 승인 연결

- 세 템플릿 선택→서버 컴파일→기존 제안→시작 승인 요청을 화면에 연결했다.
  승인된 파일·검사는 실행 준비에 자동 공급하며 실행 요청에도 범위를 표시한다.
- 불확실한 생성 응답은 요청 ID를 유지하고 자동 재전송을 차단한다.
  작업 전환 시 기존 출력 파일 선택을 초기화한다.
- lint/3typechecks 통과. 기본 backend 설정으로 dashboard 테스트를 호출한 최초
  명령은 대상 없음으로 exit1; 정식 runner 재실행은 UI21/4files, backend41/3files,
  dashboard build exit0(handle28710).
- compiled HTTP + Playwright1440/390에서 기술 검토 생성202→시험 서명 시작 승인/실행
  →준비200→실행 승인 요청202. 가로 넘침0/콘솔 오류0/실제 모델 호출0(handle51860).
- 증거·fixture 한계는 `docs/planning/adr-approved-task-templates.md`.
  실제 운영 입력·승인과 보고서 판단 평가, 기억 출처 HOLD 및 전체01–25 목표는 남아 있다.

- 기존 HEAD `15a53f699a844b4712736e5ad45ae08e1c74cbb4` 전체 verify는 별도
  `codex-morning-source`에서 exit0(handle20869): backend 1502+1547=3049/441files,
  dashboard248/35files, acceptance/smoke 통과. 전후 HEAD 동일·추적 변경0·바이트 동일.
  현재 UI diff를 포함한 전체 gate라고 해석하지 않는다. 증거는
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-task-templates-after.json`과 같은 이름 log.


## 2026-09-09 — 항목25 실제 실행 원장 성과 조회

- `report task-performance FROM TO --db PATH`: 실행 요청 생성 구간의 현재 상태,
  서명된 완료 증거 기반 성공률, 승인 접수 대기·완료 지연·열린 승인 나이 p95 조회.
  workflow 시작만으로 성공 집계하지 않고, 폐기된 증거는 별도 집계하며 비율은 null.
- 읽기 snapshot·최대1000요청·초과 시 거부. 빈 표본 null, 원문/경로/ID 출력 없음.
  실제 비용·업무 재작업 계보·외부 중복 효과·shadow 비교 기록은 미구현/unavailable.
  정책 자동 승격은 HOLD이며 이 변경은 항목25 전체 완료가 아니다.
- backendbuild+27tests/3files30.22s+lint+3types exit0(handle18627).
  최초 시험의 미래 구간·가짜 완료 삽입은 기존 검증에서 거부되어 시험 구성을 수정했다.
- 최종 실제 Claude1/독립verifier1→결과commit `2477a11b05f68b52eb549620e746fcce2fa29c9a`
  →별도 compiled CLI에서 성공1/1·승인대기2ms·완료지연34211ms(samples1/invalid0).
  첫 실사용 시험의 fixture 승인시각 역전도 invalid1/null로 구분했다.
- 격리DB/시험서명/Git이며 운영배포 없음. 증거·의미·남은 범위는
  `docs/planning/adr-task-performance.md`. 기존01–25 전체 목표를 유지한다.

- 독립 리뷰 시간 역전 지적을 수정했다. 요청보다 이른 완료는 성공수에도 포함하지
  않는다. 최종 gate79747 build+27tests/3files32.08s+lint+3types exit0.
  최종 actual/CLI33812는 commit `f9891579131171417f86e61fc86be51f8c2ac352`,
  성공1/1·승인1ms·완료37474ms·테이블 내용 전후 동일. 이 단위 실제 모델 시험은
  도우미 시각 수정과 제품 보강 재검증을 포함해 총3회이며 각각 모델1/verifier1이다.


## 2026-09-09 — 항목14 문맥 정책 순환 의존 제거

- 오류 정의를 기존 입력 경계 모듈로 이동하고 공개 평가기에서 같은 클래스·코드를
  re-export한다. 새 파일0, 정책 판단 변경0.
- 정적 ESM 그래프562모듈에서 순환3→2, 나머지2그룹 동일; 공개 export843개 이름 변경0.
- backendbuild+106tests/12files7.50s+lint+3types exit0(handle5360).
- compiled Node 프로세스1767181/1767195에서 import순서2종·오류 클래스 동일성·
  오류코드2종·정상/불신 정책 판단 통과. DB/모델 호출 없음.
- 상세 `docs/planning/adr-runtime-module-boundaries.md`; authority/memory 및 task 순환과
  전체01–25 개발 목표는 남아 있다.


## 2026-09-09 — 항목14 권한·기억 저장소 순환 제거

- JarvisError 단일 정의를 의존 없는 leaf로 분리하고 기존 공개 경로의 동일 클래스를
  유지했다. 진행 parser와 기억 투영 두 모듈의 DB 역참조를 제거했다.
- 정적 ESM 그래프563모듈/1969edges에서 순환2→1; 남은 task 순환21모듈.
  공개 export843개 이름 유지. progress는 import 경로를 정규화한 TS AST가 전후 동일하다.
  단순 scanner 비교는 template literal 재스캔 부재로 실패하여 AST 비교로 교체했다.
- build+60tests/12files37.19s+lint+3types exit0(handle50650). 처음 검증은 기존
  progress 긴 줄 제한으로 실패했고 줄바꿈 후 재검증했다.
- compiled Node 진입 순서3종(progress/projection/db), PID1808322/1808389/1808420:
  공개 경로5개의 클래스 동일성, 각 프로세스의 오류3종 거부, 실제 격리 SQLite
  migration 및 ready 검사 통과. 운영DB·외부 모델 호출 없음.
- 전체01–25 및 나머지 task 순환은 미완료. 운영 배포는 하지 않았다.


## 2026-09-09 — 항목14 작업 명세의 실행 계층 역참조 제거

- 기존 task-spec 공개 경로를 유지하고 입력 검증 구현을 task-spec-input으로 옮겼다.
  control-workflow-input/task-candidate-provider가 검증 모듈을 직접 참조한다.
  옮긴 interface/함수 본문은 원본과 바이트 동일; 오류는 기존 단일 leaf를 사용한다.
- 정적 ESM 그래프564모듈/1970edges, 순환1→0. 공개 export843개 목록 동일.
  동적 import/require 및 외부 라이브러리는 이 측정 범위에 포함되지 않는다.
- backendbuild+100tests/10files58.79s+lint+3types exit0(handle38378).
  템플릿3종의 승인→검증→Git발행→재생은 fixture provider/서명 경로이며,
  compiled CLI staging 및 완료 증거·철회·rollback 검사도 포함한다.
- 별도 compiled Node3개(PID1828610/1828618/1828627)에서 import순서3종,
  공개/내부 함수3개의 동일성, 정상명세 수용 및 예산/제약/담당범위 변조3종 거부.
  모델 호출·운영DB·서비스 변경 없음.
- 전체01–25 목표는 유지하며 정적 순환 제거를 구조·운영 전체 완료로 간주하지 않는다.


## 2026-09-09 — 항목20/21/24 CLI의 모호한 JSON 입력 거부

- 라우팅 분류/실행 계획/템플릿의 중복 키 수용을3개 실패 테스트로 재현했다.
  기존 strict-json을 공통 파일 reader에 적용하여 해석 후 같은 키도 거부하고
  깊이32/노드8192/작업32768 및 기존 파일 크기 상한을 적용했다.
- build+47tests/6files11.62s+lint+3types exit0(handle45077).
- compiled CLI 정상3개 exit0·중복3개 exit2; DB 생성0·비공개 입력 노출0.
  추가로 중복 정책 거부와128파일/8검사/검사당64인자 정상계획 수용 확인.
- 상세 ADR `docs/planning/adr-routing-json-boundary.md`. 승인·실행 권한 부여 없음.
  전체 검증6927은80f58a5에 고정되어 실행 중이며 이 수정은 포함하지 않는다.


## 2026-09-09 — 항목12 아침·저녁 설정 해석 보강

- 중복 max_work 설정이 아침/저녁 작업을 실행시키는2개 회귀를 재현했다.
  기존 strict-json 및 fatal UTF-8을 적용하고 기존8/16KiB 상한·키 권한·예산을 유지했다.
- build+49tests/5files30.20s+lint+3types exit0(handle42605).
- compiled Node4프로세스: 중복설정2건 exit2/일일run0, 정상2건 exit0/completed.
  격리DB·시험키·주입시계·빈원본이며 자동운영HOLD 유지, 시험파일 삭제.
- 별도 발견: event:a/event_a의 일일 키 충돌을 compiled 함수에서 확인.
  기존 불변원장/재생 호환 검토가 필요하여 event 활성화HOLD. 상세와 재개 조건은
  `docs/planning/adr-daily-config-json.md`. 전체01–25 및 refresh/retention 인수는 남는다.


## 2026-09-09 — 항목12/23 일일 이벤트 키 충돌 수정

- 신규 event:v2 해시 키로 치환 충돌을 제거하고 원본ID 조회/기존키 재사용을
  IMMEDIATE transaction 안에서 수행한다. 일정키와 불변 입력 비교는 유지했다.
- 신규 migration075의 날짜/원본ID unique index가 구/신 작성자의 중복 저장을
  차단한다. 기존 SQL 변경0. 원본없는 version0 점유키는 자동복제 없이HOLD.
- final build+127tests/9files59.62s+lint+3types exit0(handle60232).
- 실제 구버전74 DB→새버전75 upgrade/같은run 재생, 충돌ID 별도run 저장,
  IPC barrier의 새작성자2개 동일run 수렴, 구버전 중복거부 후 새버전재생 확인.
  최종run3개(handle59971). 격리SQLite/합성이벤트이며 운영·외부효과 없음.
- 상세 `docs/planning/adr-daily-event-identity.md`. 실 이벤트 처리기/커넥터/운영HOLD와
  전체01–25 목표는 유지한다. 전체verify6927은80f58a5에 고정되어 실행 중이다.


## 2026-09-09 — 고정80f58a5 누적 전체 검증 완료

- 별도codex/morning-source의 npm run verify(handle6927) exit0.
  backend1505+1548=3053/442files, dashboard252/36files, 총3305tests.
  고정시각pre-GJC acceptance도 exit0. 전후HEAD80f58a5/추적파일바이트동일.
- 증거 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-runtime-boundaries-after.json`
  및동명log. 이후3d61493·7dd1d4c·이벤트키 수정은 이전체gate에 포함되지 않는다.

## 2026-09-09 — 항목12/23 구버전 유예 응답 키 일치

- 회귀85023에서 저장된 legacy키와 반환된v2키 불일치1건을 재현했다.
  같은 IMMEDIATE 준비 트랜잭션의 run ID/선택키를 응답에 사용하도록 수정했다.
  기존 store.prepare의 string API와 일반 prepared 응답 필드를 유지한다.
- build+128tests/9files60.06s+lint+3types exit0(handle58020).
- 실제 Node5프로세스/격리SQLite: 구버전3모듈로 저장→신버전 동일응답,
  충돌ID 신규v2키, 재실행 원장불변, 일반응답4필드, 최종run3개 확인(9925 exit0).
  구버전모듈은7dd1d4c 원문을 변환했으며 지원build/75스키마는 현재판이다.
  합성이벤트·모델0·운영변경0이며 전체구버전release 인수는 아니다.
- 상세/재현/영수증: docs/planning/adr-daily-event-identity.md.
  실 커넥터/이벤트처리/운영 활성화HOLD와 전체01–25 목표를 유지한다.
  고정6d8031d 전체verify37465는 별도로 진행 중이며 이번 수정은 제외된다.

## 2026-09-09 — 항목15/19/21 verifier 빌드 권한 정규화

- 실제 현재산출물 task-verifier-main.js mode664와 checkReady exit2
  TASK_VERIFIER_UNAVAILABLE을 확인했다. build의 umask에022를 추가하고
  복사된 산출물까지 그룹/기타 쓰기권한을 제거한 후 최종모드 digest를 기록한다.
- build+55tests/5files17.32s+lint+3types exit0(handle48867).
- 실제 umask000 자식build→새Node readiness/격리DB identity 인수50995 exit0:
  산출물1138개 중 그룹/기타 쓰기가능0개, verifier644·준비성공, 키640 거부,
  build/DB matched. 수동산출물chmod0·모델0·운영변경0.
- 첫 인수harness는 reader에 SQLite handle 대신 AuthorityDb를 전달해 실패했다.
  harness수정 후 동일제품으로 재인수했으며 키/DB는 제거했다.
- docs/planning/adr-backend-artifact-permissions.md에 재현/영수증/제한 기록.
  설치의 전체 의존성·상위경로 권한/운영release 인수와 전체01–25 목표는 남는다.

## 2026-09-09 — 수동 권한 조정 없는 실제 실행 및 전체 검증 결함 수정

- da25e6b fresh build→실제 Claude1/독립verifier1→기술검토report.json→
  결과commit fd407510b8995a2147cd6f5f8bf5fbf22f1b091d→서명완료증거→별도성과CLI
  exit0(handle78760). 수동artifact chmod0, 준비쓰기0, 재실행 추가호출0,
  원본HEAD/status/source·재실행refs 보존. 성과1/1·승인1ms·완료56255ms.
  격리fixture DB/Git/시험승인키이며 운영활성화0, 단일표본이다.
  receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-D698t5/receipt.json
- 고정6d8031d 전체verify37465 exit1: backend1513+1548=3061pass/2fail,
  444files 중1fail. 전후HEAD/추적바이트동일. 실패2개는 schema035 fixture에서
  최신이벤트준비가 요구하는075 index 부재로 발생했다. dashboard/후속gate 미실행.
- 035 검증을 유지하고 최신실행 전에 현행migration을 적용한다. 적용 전 거부/
  원장불변 및 적용 후 원장불변 검사를 추가했다. 별도035 SQL cross-run 검증은
  지원되는 예약run을 사용하며 기존거부/재개검사를 그대로 유지한다.
- 제품/기존migration 수정0. build+28tests/3files12.55s+lint+3types exit0(62972).
  전체gate 재실행이 필요하며 전체01–25·운영/커넥터/기억출처HOLD는 유지한다.

## 2026-09-09 — 항목12/23 커넥터 Unicode 설정 경계

- 실제 소스 대조: calendar/mail/messenger configured=false, 기존registry는
  second_brain/orca/task_timeline/portfolio를 구성한다. 외부연결 활성화HOLD 유지.
- 설정 문자열 마지막 high surrogate의 다음 charCodeAt이NaN이라 범위비교를
  통과하는 결함 확인. 검색어/Orca경로 회귀 총2개 실패(29092 exit1).
  기존 검사에 문자열 끝 검사를 추가했다. 유효한 한글/이모지/NFC·argv보존은 유지.
- 최종 build+63tests/6files45.57s+lint+3types exit0(33324).
  잘못된 검색어/경로5종씩, provider호출0·DB변경0, 정상문자열을 검증했다.
- 실제 별도Node/컴파일registry에서 설정10개 거부, 정상Unicode경로의 자식
  프로세스argv 보존·빈응답no_data·DB쓰기0 확인. source응답은fixture이며
  실제Orca0·모델0·운영0이다. 생성DB는 제거했다.
  receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/connector-unicode-oBsNq3/receipt.json
  script: /home/jm/.cache/jarvis-test-runtime-qa-20260908/connector-unicode-live.mjs
- 부모가 전체diff를 검토했다. 동종 morning/evening 문자열 검사에는 이미
  문자열끝 검사가 있어 추가 제품변경은 없다. 전체01–25 목표는 유지한다.
  고정c9062b2 전체verify61099 실행 중이며 이번 변경은 해당gate에서 제외된다.

## 2026-09-09 — 항목18 커넥터 fixture 초기화 비용 축소

- 커넥터 전용 fixture에서 실제 migrate()로 만든 빈 스키마 이미지 한 개를
  모듈내 재사용한다. 테스트마다 별도0600 DB파일과 새 AuthorityDb를 만들고
  현재migration checksum을 재검사한다. 제품·일반helper·migration테스트 변경0.
- 기존63tests/6files45.57s→기존63+신규2tests/7files11.77s. 단일실행 실측이며
  전체suite 속도 개선 수치가 아니다. final build/lint/3types도 exit0(96391).
- 신규검증은 전체schema/기본데이터, 설치시각2필드의 형식, integrity/FK,
  동시복제·쓰기격리·checksum손상격리다. 초기1실패는 quarantine 설치시각
  차이였으며 허용되는 시간필드를 명시한 후 통과했다.
- 실제 컴파일fixture5표본: fresh513.4–545.5ms, 최초seed442.1ms,
  복제+검사13.8–29.9ms(56080 exit0). 실험DB제거·모델0·운영0.
- docs/planning/adr-connector-schema-fixture.md에 근거/제한 기록. 설치시각이나
  마이그레이션 적용 자체를 시험하는 fixture로 확장하지 않는다.
  고정c9062b2 verify61099와 전체01–25 목표는 계속 진행 중이다.


## 2026-09-09 — main 통합 후보의 검증 결함 수정

- 개발aae919a와 main9ab8293을 소유 작업공간에서 병합 중이다. main 작업공간의
  기존 변경은 유지했다. 번호072–075가 겹치는 SQL 네 쌍의 원문/파일명은 보존한다.
- 1차 전체 검증의 첫 묶음1604pass/15fail을 수정했다. 2차 전체30687은
  첫 묶음1619pass, 두 번째1628pass/1fail로 종료했고 HEAD/추적파일 바이트동일.
  마지막 실패는 별도마이그레이션 번호검사의 중복불허 가정이다. 명시된 네 쌍만
  허용하도록 수정했다. 이 실패실행의 dashboard/acceptance/smoke는 미실행이다.
- 명령등록/DB교체/요청인증/기억중복판정을 분리하고 기존 크기검사를 유지했다.
  static ESM593modules/2118edges/0cycles, 공개export882(27580 exit0).
- 직접호출 기억응답 파서의 malformed Unicode ID3종을 거부한다. 실제wire
  decoder는 이미 거부하므로 wire우회로 보고하지 않는다. red3fail→scope/migration
  23pass(18023), client/transport/strictJSON/reviewability13pass(96363).
  backend build/lint/3types43685 exit0, SQL80files/산출물1208개.
- 컴파일된 직접조회/검색에서 정상ID4건보존·비정상6건거부, provider0(8519ed).
  격리실제Claude1/verifier1→결과commit→재실행추가호출0,42193ms(50888).
  후자는 최종ID guard전 병합빌드이며 fixture승인/DB/Git, 운영활성화0이다.
- 실제취소발급은5Node프로세스·commit직후exit77·동일재생·claim순서거부를
  확인했다(46550). DB교체/제공자처리전체인수와 구분한다.
- 상세증거/제한은 docs/planning/adr-main-integration-2026-09-09.md.
  최종전체gate·독립리뷰·병합커밋은 남는다. 전체01–25와 운영/커넥터/출처HOLD 유지.


## 2026-09-09 — 최종 통합 전체 검증 통과

- npm run verify56886 exit0. backend1623+1629=3252/467files,
  dashboard252/36files, 총3504tests/503files. runtime/lint/3types/build,
  고정시각acceptance/CLI smoke 통과. 전후HEAD/추적파일 바이트동일.
- 격리 부모SQL75/76→80 업그레이드에 미승인명령/이벤트/보존작업3행씩을 추가해
  비journal 원문12행보존·재적용동일·승인없는실행거부·integrity ok/FK0 확인(2024).
  현재런타임+부모SQL이며 운영DB복제/과거바이너리인수와 구분한다.
- 읽기전용systemd조회: authority/dashboard/phone active, morning/evening timer
  not-found. authority의 localhost 외IP차단 설정은 관측했지만 실제cgroup내
  네트워크효과는 시험하지 않았다. 셸Claude인수와 운영서비스인수를 구분한다.
- 독립리뷰와 병합커밋은 다음 단계다. 전체01–25/운영/커넥터/기억출처HOLD 유지.


## 2026-09-09 — 고정 main 통합 인수

- 독립 읽기전용리뷰 main_merge_review ship, 차단지적0, staged135파일 해시일치.
  요청gpt-5.6-sol/high, 실제런타임모델/effort 미노출. 리뷰어는 테스트재실행없음.
- 부모 browser E2E50525 exit0,1440/1024 화면26개통과/1.1m. 승인/실행/재계획/
  재시도와 접근성심각오류0·넘침없음 확인. 전체gate후 제품/테스트소스변경0.
- 고정aae919a+9ab8293 통합을 소스커밋 대상으로 인수한다. 이후main53c67b1의
  7커밋/17파일은 제외한다. 전체01–25/운영/커넥터/출처·성과지표 남은범위 유지.


## 2026-09-09 — scoped 요청 후속 통합 검증

- 이전 통합 b01c9bba5fa0b196d03792402d8f0fdfafff3c5b 완료 후
  main a4ec505bbdf1913e70701a22e7ca476225b91011의 8커밋을 소유 작업공간에서 통합한다.
- 부모 SQL80/77파일 원문 변경0, 합계81. build/lint/3types와 관련91tests 통과.
- 컴파일된 spool을 실제3Node에서 종료exit73→재시도exit0, 동일inode/bytes·link2→1 확인.
  fixture자료이며 provider0/운영0. 별도2Node DB80→81에서 queued1·기존열보존,
  profile legacy/FK0/quick_check ok. 증거는 cache scoped-followup-live.json 및
  scoped-followup-migration-live.json이다.
- 기존 크기 검사 실제실패: index 비공백251줄, codec196자/spool174자.
  전체verify95070은 해당 실패 확인 후 명시중단exit130이며 전체통과가 아니다.
  scoped export 모듈분리와 줄바꿈 후 관련24tests/3files 통과. 공개runtime export391개
  이름/참조동일. 기존250줄/160자 기준 및 SQL변경0.
- 수정 후 전체gate·독립리뷰·커밋은 남는다. scoped 승인소비/outbox등록/provider전송과
  운영활성화는 미완료이며 전체01–25 목표를 유지한다.


## 2026-09-09 — scoped 후속 통합 인수

- 최종 npm run verify12178 exit0: backend1639+1647=3286/471files,
  dashboard252/36files, 합계3538tests/507files. runtime/lint/3types/build/
  fixed-clock acceptance/CLI smoke 통과. 전후추적1623파일·HEAD동일.
- 독립 scoped_followup_review ship, 지적0, staged26파일 해시일치.
  요청gpt-5.6-sol/high, 실제모델/effort/사용량미노출. 리뷰어 테스트재실행0.
- static ESM598modules/2142edges/0cycles, 타입포함공개export888.
  public runtime export391의 기존이름/참조동일은 별도검증이다.
- 검증된 b01c9bb+a4ec505 통합을 소스커밋 대상으로 인수한다.
  전체gate후 제품/테스트변경0, 이 결과기록만 추가했다.
- scoped 승인소비/원자적outbox등록/provider영수증/과거worker갱신준비/
  spool inventory·cleanup 및 운영활성화는 미완료. PID재사용복구는 거부한다.
  전체01–25 목표와 실제운영·커넥터·기억출처·성과지표의 남은 범위는 유지한다.


## 2026-09-09 — 항목25 Claude 사용량 수집

- provider 결과에 입력/출력/캐시읽기/캐시생성 및 CLI 비용추정 관측을 보존한다.
  누락/비정상/보고값을 구분하고 후보본문·승인·실행권한과 분리한다.
- build/lint/3types exit0, 관련29+34=63tests 통과. 실제Claude1/verifier1
  완료37253ms, 재시도추가호출0. 입력4/출력2749/cache read5139/create6770,
  CLI추정USD0.1411745. 실제청구/전체작업비용과 다르다. 격리fixture/운영0.
- 근거·잔여범위는 docs/planning/task-provider-usage-observation.md.
  호출식별자에묶은DB저장·실패포함coverage·성공당집계·실제청구비용은 남는다.

- 독립 task_usage_review ship/수정지적0, 요청terra/medium, 실제모델/effort미노출.
  검증후7파일바이트동일 확인 후 인수결과문서만 추가. 수집단위를 커밋하며
  DB저장·실패coverage·집계와 전체01–25는 완료로 처리하지 않는다.

## 2026-09-09 — 항목25 호출 원장 사용량 및 비용 추정 집계

- 기존control_events에 호출ID당1개관측을 기록한다. 요청/승인/fence/run/plan결합,
  canonical/digest/시각검사와 재생충돌거부. 취소/만료후관측은 실행권한이 아니다.
- 같은요청cohort의 전체시도비용추정 합계와 검증성공당추정을 추가한다.
  누락/비정상/성공근거무효/성공0은 비율null. 청구확정액은 여전히 unavailable.
- build/lint/3types exit0, 관련40tests/4files33.16s. 실제Claude1/verifier1
  완료43906ms, 독립CLI가 DB관측1건·USD0.18251399999999998추정을 동일회수.
  재시도추가호출0, 조회원장불변. 격리승인/DB/Git이며 운영변경0.
- 상세근거/종료시관측유실·CLI오류응답비용복구·청구·보존정책제한은
  docs/planning/task-provider-usage-observation.md. 전체01–25는 미완료다.

- 독립 task_usage_ledger_review ship/지적0. 요청terra/high, 실제모델/effort미노출.
  리뷰대상7파일바이트동일 확인 후 인수기록만 추가하고 사용량원장·집계단위를 커밋한다.
  fixture 결과commit은 격리리포정리후 현재작업트리에 없으며 보존receipt로 확인한다.


### Failed Claude result usage and full baseline verification — 2026-09-09

- Previous goal turn made progress: full verify27988 terminated exit0 at
  a3dfbe902e4040505d7e4b6808b6fef46921c0e3. Backend1642/237files760.10s
  +1673/236files732.17s; dashboard252/36files33.03s =3567tests/509files.
  Runtime/lint/three type checks/build/fixed-clock acceptance/CLI smoke passed.
  usage-full-before.json/usage-full-after.json proved1629 tracked files unchanged.
- Current unit preserves normalized failed CLI result usage without promoting
  failed execution. Crash values remain invalid; budget-error tokens are invalid
  separately from the reported estimate. Existing event schema/migrations unchanged.
- First tests96074 exit1:3 replay assertions wrongly expected a returned result;
  actual CONTROL_APPROVAL_REQUIRED is the required rejection. Corrected assertions
  and final73232 exit0:79tests/6files34.02s. Build97821 and lint/types76770 exit0.
- Actual19839 exit0: failure-usage-real-bB9OuL/receipt.json, provider1/verifier0,
  uncertain/TASK_PROVIDER_FAILED, no completion, replay rejected, estimate0.002148
  USD persisted and read by separate CLI, per-success null, elapsed2753ms.
  Isolated signed fixture approval/DB/Git and acceptance-only low-budget wrapper;
  no operational restart/deploy/configuration change. Earlier acceptance attempts
  and their limits are documented in task-provider-usage-observation.md.
- Parent implementation/verification completed; independent acceptance pending.
  All cache receipts are under /home/jm/.cache/jarvis-test-runtime-qa-20260908/.
  Full01–25 remains incomplete; billing/process-loss/shadow/rework items remain.
- Independent failure_usage_review returned ship/findings0; all8 reviewed file
  hashes matched. Requested terra/high; runtime model/effort unobservable.
  Final build/lint/three type checks26572 exit0. Parent accepted the bounded unit
  after review; only this acceptance record was appended before commit.


### Scoped outbox integration acceptance — 2026-09-09

- Integrated six pinned commits through3034eda1eca7fefdd3c5cb7527daea3f284f4faf
  into1a020bd3c97792a3f04b834d1120e08be856b8cf; merge commit pending review.
  Index export conflict resolved through existing memory-scoped-api barrel.
  Five incoming files needed line wrapping for repository reviewability limits.
- Focused tests:66 passed with1 source-reviewability failure, then remaining two
  line-length violations fixed and reviewability2 passed. Final full verify93066
  exit0: backend1684/240files759.21s +1708/239files757.55s; dashboard252/36files
  32.22s, total3644tests/515files. Runtime/lint/three typechecks/build/fixed-clock
  acceptance/CLI smoke passed. scoped-dispatch-full-before/after.json records
  1653 tracked files unchanged during the full gate.
- Parent inspected production/test/fixture/docs diff. Existing SQL bytes from
  parents81/78files preserved. Isolated populated DB upgrade81→82 with two Node
  processes preserved one queued legacy outbox and every column; FK0/quick_checkok.
- Compiled worker acceptance83056 exit0:13 child processes, two crash/fence
  scenarios, attempts1 each, re-dispatch claims0, FK0, reconciling retained.
  Compiled cross-repo result acceptance11956 exit0:Python3/Node3, acknowledgement
  loss exit73, acceptance events1, FK0, provider proved/JARVIS reconciling.
  Fixture authority and internal API transport; no public MCP or production grant.
- Static runtime import graph609modules/2205edges/cycles0; TypeScript exports898
  include types. Runtime exports399, eight added functions match original module
  references with mismatches0. Logs/receipts: scoped-dispatch-* and
  verify-scoped-dispatch-full.log under /home/jm/.cache/jarvis-test-runtime-qa-20260908/.
- HOLD: generation identity/proof alone does not attest stored project access
  classification. proof_consistent/remembered_content_observed never settle an
  outbox or complete control. Current write transport, authenticated provider
  receipt consumption, exact stored scope proof, original task→derived memory
  suppression/deletion lifecycle and operational activation remain incomplete.
  No deployment/service restart/operational DB mutation performed. Full01–25 open.

- Independent scoped_dispatch_review returned fix-first with one major finding:
  a recovered late acceptance left DISPATCH_OUTCOME_UNKNOWN after attempt accepted.
  Parent clears only that stale code on matching scoped-v4/reconciling/fence,
  retains reconciling and unrelated reasons, and asserts replay adds no DB writes.
- Post-fix build98644 exit0; tests78435 exit0:18tests/4files15.52s;
  lint/three typechecks72902 exit0. Actual2996 exit0:Python3/Node3 replay/crash
  acceptance, events1/FK0, stale_failure_code null, reconciling retained.
  Receipt scoped-dispatch-late-live.json; test log scoped-dispatch-late-tests.log.
  Prior full3644 is pre-fix; the post-fix change has focused and actual coverage.
- SB latest SCOPED-GENERATION-IDENTITY-FIX-2026-09-09.md reports provider-side
  access classification binding repaired. Earlier P0 statements are historical.
  JARVIS exact scoped evidence, authenticated consumption, old-reader/old-generation
  rollout and automatic settlement remain HOLD; provider repair alone does not
  satisfy those integration requirements. Fresh post-fix review pending.

- Fresh independent scoped_late_acceptance_review returned ship/findings0.
  Reviewer checked all31 packet hashes, acceptance transaction and replay assertions;
  no tests rerun by reviewer. Parent revalidated31/31 hashes and both merge parents
  before acceptance. Full3644 gate predates fix; post-fix18 and crash/replay evidence
  remain the final verification scope. Requested terra/high; actual model/effort
  and token usage unavailable. Parent accepts this bounded integration for commit.

### Historical routing shadow comparison — 2026-09-09

- Previous goal turn progressed: merge commit c045bff completed. This unit adds
  report routing-shadow over original task.execute/TaskSpec inputs, explicit
  baseline/candidate policy digests, classification transitions and coverage.
- Build23563 exit0, focused29838:34tests/5files10.73s, lint/three types77099 exit0.
  Actual compiled85833:2CLIchildren, changedtarget1, stablecohortdigest, provider0,
  pendingtask and logicalDBunchanged. Fixture input, no production policy installed.
- Parent inspected5-file packet; independent routing_shadow_review still running
  at the latest native list_agents observation. Commit awaits its verdict.
  Details: docs/planning/adr-task-routing-shadow.md. Outcome shadow comparison,
  automatic policy promotion, operational activation and full01–25 remain open.
- Independent routing_shadow_review completed ship/findings0. Parent rechecked
  5/5 reviewed hashes at c045bff, accepted this unit for commit. Actual model/effort
  and token telemetry unavailable; no cost estimate. Full01–25 remains active.

### Approved per-task routing — 2026-09-09

- Previous goal turn progressed: routing shadow committed6deea8d. New HTTP task
  routing proposal is recomputed, selected registered executor persisted in
  TaskSpec digest and enforced against provider during execution binding checks.
  No-match/conflict returns409, stale binding400, unregistered executor409.
- Final31305 build+49tests/6files29.93s; regression79767:73tests/5files47.92s.
  Lint/three typechecks34002 exit0. Earlier format/lint failures documented in ADR.
- Actual78083 exit0:Claude1/verifier1, result a6210f19f8c4babcf23b91bffb0b7303bb8cc5ea,
  elapsed42490ms, routing/specdigest retained, replay calls0, originalsource/HEAD
  preserved. Isolated fixture/key, not production activation. Staticcycles0.
- Read-only approved_routing_review dispatched terra/high, verdict pending.
  Parent packet11/11 matches. Details docs/planning/adr-approved-task-routing.md.
  UI policy controls/global default/other executors/record-store effects and
  full01–25 remain incomplete; no service/configuration/productionDB changes.

- Independent approved_routing_review returned ship/findings0. Parent verified
  11/11 packet hashes before acceptance; requested terra/high, actual metadata
  unavailable. No product changes after final checks. Accepted for bounded commit.

### Routing selection display — 2026-09-09

- Isolated branch codex/routing-approval-ui starts at912736e while the original
  integration worktree's full verify92007 remains live; no original source edits.
- Added original-command-bound display projection, guarded optional API fields,
  preparation/request summaries and unsupported executor preparation blocking.
- Backend projection85339:3pass; frontend22503:10pass then updated2362:3pass
  (11 distinct frontend tests including existing8). Lint81924, build12274 and
  final three typechecks14312 exited0. Reviewability/projection17914:5pass.
- Actual isolated Playwright80711 exited0 at widths1440/390: prepare200,
  stage202, same task-spec digest in authenticated refresh, console0/overflow0,
  real model calls0. Receipt routing-ui-20260909/browser-receipt.json in QA cache.
  Browser plugin unavailable; source selection/approval preparation only, not
  production dispatch or live event-stream readiness. Screenshot inspected.
- Fresh routing_ui_review requested terra/high, read-only task constraint;
  returned ship/code findings0. Parent accepts the reviewed unit for commit.
  Actual model/effort and token telemetry unavailable. Full01–25 and previously
  recorded HOLD items remain.

### Full routing baseline and indexed task reads — 2026-09-09

- Previous goal turn progressed: routed approval UI committed3df01c4. Full
  verify92007 finished exit0 at912736e: backend1686/241files778.11s plus
  1715/240files812.00s; dashboard252/36files35.26s. Total3653tests/517files.
  Runtime/lint/three typechecks/build/fixed-clock acceptance/CLI smoke passed.
  verify-approved-routing-before/after.json proves1659 tracked files unchanged.
- Fast-forwarded codex/priority-deadline-evidence to reviewed UI commit3df01c4
  after snapshot verification. Full3653 predates UI and index changes.
- Current branch codex/routing-approval-ui adds forward migration079 (83rd file)
  for four task/routing lookup indexes. All82 prior SQL files unchanged. Three
  actual SQL query plans changed from scans/sorts to indexed searches. 10k/100k
  benchmark receipts and exact limits are in adr-task-execution-read-indexes.md.
- Final focused74169:36pass; migration83625:7pass. Lint/types88739 and build83625
  exit0. Native routing_index_review returned ship/findings0, packet hashes5/5
  matched. Requested sol/high, actual runtime metadata/token usage unavailable.
  Parent accepts the bounded index change for commit. Full01–25 remains active.

### Late-bound subject suppression — 2026-09-09

- Previous goal turn progressed: index optimization8e1db4e committed/integrated;
  full verify56591 on that immutable integration source remains live.
- Inspection found activateForSequence matches keyed_subject_digest while late
  activateRef omitted it. After correcting fixture target setup,90978 reproduced
  two failures: a late root and an inherited child remained visible.
- Added the same keyed-subject match and forward migration080 for preexisting
  missing links. Earlier83migrationbytes unchanged; tombstone/event/dependency
  identity preserved. Complete task-to-memory/provider lineage remains HOLD.
- New/existing focused41955:11pass. Broader direct24449 hit tmp EDQUOT(-122)
  and SQLite I/O errors; standard scratch-isolating runner54248 passed49tests/
  11files43.31s. Use repository runner for subsequent focused DB suites.
- Lint/3types84127 and backend17286 exit0. Actual compiled Node readers2 each
  returned linked_visiblefalse/unrelatedtrue/child_suppressedtrue/read_writes0.
  Provider0/operationalchanges0; cache late-subject-live.json and ADR record limits.
- Fresh native late_subject_review requested terra/high, no external review
  services/install/auth authorized. Returned ship/findings0; hashes3/3 matched.
  Requested terra/high; actual metadata/token usage unavailable. Parent accepts
  this local visibility fix for commit; in-flight notifications/provider lifecycle
  and the full01–25 objective remain open.

### Late notification lifecycle and full gate failure — 2026-09-09

- ca4fb77 completes the bounded late notification suppression correction. Canonical
  focused suite: 48 tests / 8 files passed. Typecheck/lint/backend build, fixed-clock
  acceptance and CLI smoke exited 0. Compiled two-process DB reopen rejected a
  contradictory delivered acknowledgment and returned no repeated claim or receipt.
  External provider calls 0; external recall and provider lifecycle remain HOLD.
  Native late_notification_review returned ship/findings0; actual model/effort
  and token usage unobservable. Details: adr-late-notification-suppression.md.
- Full verify56591 on 8e1db4e is terminal exit1. Backend shard1:1685pass/2fail
  in242files; shard2:1719pass in241files. Both failures are 5000ms timeouts in
  memory-cancellation-compaction.test.ts (physical replacement5785ms and atomic
  settle/replay5168ms). Dashboard/acceptance/smoke were not reached by this gate.
- Before/after snapshot comparison: HEAD8e1db4e unchanged,1666 tracked hashes
  matched,0 mismatches. This is a failed gate, not completion evidence. After its
  terminal result, integration fast-forwarded to ca4fb77, including4c483a1.
  Whole01–25 remains active; failure triage and final integrated gate remain open.
- Isolated canonical reproduction29189 also failed the same2 tests (9passed),
  confirming the default5s harness budget issue outside the full suite. Only those
  two end-to-end compaction test budgets now use15s, matching existing interrupted
  recovery cases. Runtime watchdog remains5000ms; product deadlines and test bodies
  are byte-identical after removing the added comments/budget arguments.
- Focused retry33975 exited0:11tests passed. Targeted ESLint37511 and diff check
  exited0. This test-only correction does not assert a compaction latency SLA or
  validate real provider deletion. A new fixed-source full gate is still required.

### Task identity boundary and physical test budgets — 2026-09-09

- 82cb28e applies task-ID suppression to execution detail, shared execution binding,
  and approved completed-result replay. Parent49tests/4files passed, then final
  snapshot/interleaving21tests/2files passed; types/lint/build/acceptance/smoke exit0.
  Compiled HTTP200→404, unrelated200, readwrites0/provider0. Initial review fix-first
  for split replay snapshots; fresh final review ship/findings0 after one deferred
  snapshot and two-connection regression. Task-memory lineage remains HOLD.
- Current full verify89979 remains live at6380e1d; shard1 already reports3 failures,
  all5000ms physical reconstruction timeouts (5229/5294/5335ms),1692pass/3fail.
  Do not restart it while shard2 remains live or cite it as a passing full gate.
- Apply15s suite budgets to physical cancellation reconstruction and fresh-file
  reconstruction, and15s to cancellation→follow-up integration. Ordinary default
  test budgets, runtime watchdogs, leases, migrations and product code unchanged.
  TypeScript AST comparison proves12 test callback bodies unchanged across3files.
- Focused88086:13tests/3files passed69.80s. Three typechecks and targeted ESLint37128
  exit0; diff check exit0. Existing physical-file replacement and recovery assertions
  execute unchanged; this test budget is not a product performance SLA.

### Latest dashboard browser acceptance — 2026-09-09

- At646d119, canonical npm run test:e2e session22978 exited0 after backend/dashboard
  build. Chromium1440/1024:26tests passed1.2m,1worker/0retries. Covered overview,
  task detail, Korean rendering, redaction, empty state, read-only proposal preview,
  signed approve/execute/reject, cancellation, retry/replan and accessibility/overflow.
- Fixture web servers use isolated seeded databases; this is not a production smoke
  or external model workflow. Task-ID quarantineHTTP200→404 is separately verified
  in82cb28e's ADR; the26browser cases do not specifically cover that added boundary.
- After browser completion, HEAD646d119 remained and git status had only untracked
  node_modules. No product edits were made during this browser run. Full verify89979
  remains a separate live run on6380e1d with known first-shard timeouts; latest browser
  acceptance does not change that failing gate status or complete the01–25 objective.

### Frozen integration gate settlement — 2026-09-09

- verify89979 terminal exit1 on6380e1d: shard1 1692pass/3timeout failures
  in242files845.02s; shard2 1722pass/242files836.74s. All3 failures are the known
  physical reconstruction5s budgets corrected by646d119. No additional failed cases.
  Dashboard/acceptance/smoke not reached by this gate.
- Before/after HEAD6380e1d and1671 tracked SHA256 hashes match exactly,0mismatches.
  Latest queued commits include task identity privacy82cb28e, physical budgets646d119,
  browser acceptance41aecdc, binding lookup3cc50f1 and provider lineage gapc6e67f7.
  This failed run cannot prove those newer changes; integrate only after terminal
  snapshot verification, then start a new fixed-source full gate.

### Release rehearsal scope and executable payload HOLD — 2026-09-09

- Existing compiled rehearsal on an isolated cache root exited0/OK, but executing
  its published current/dist/src/cli.js --help exited1/ERR_MODULE_NOT_FOUND for
  dist/src/db.js. writeRehearsalPayload copies selected entry files and migrations,
  not the runtime module/dependency closure. Reproduction receipt directory:
  release-runtime-audit-oh62dgtp under the shared QA cache.
- Keep this fixture payload HOLD for deployment. Rehearsal output and operator
  handoff now explicitly report scope=fixture_backup_restore_and_release_pointer,
  deployment_ready=false/runtime_payload=incomplete/runtime_validation=not_performed.
  Existing backup/restore and relative release-pointer rehearsal behavior remains.
- Parent3tests passed; types/lint/backend build exit0 after correcting an initially
  omitted return field caught by TS2739. Actual compiled CLI47222 exit0 confirms
  output/handoff agree, restore quick_check=ok, production open_attempts0.
  Receipt release-scope-verified-wcm1g5pc/verified-cli-result.json in QA cache.
- Resume executable release acceptance only with a complete module/dependency
  payload, real source/build identity, packaged CLI startup and isolated health/
  doctor/contract checks. Fixture manifest IDs and a source-string execute check
  are not sufficient. No production service, symlink or database was changed.

### Complete runtime payload experiment — 2026-09-09

- Source `2e0aa3f8e17d4265076fdd11d5ebcc866fd1096c`: full backend/dashboard
  build exit0. Copied dist, migrations, config, package.json and package-lock.json
  into isolated QA cache `runtime-package-7htxb2nv`; 1356 payload file hashes
  match the source build, mismatch count0.
- In that package root, `npm ci --omit=dev --offline --no-audit --no-fund`
  exited0 and installed69 packages. node_modules is a real directory;
  Electron absent. This is a local cached-install result, not an offline
  reproducibility proof or a portable native-addon guarantee.
- Packaged `node dist/src/cli.js --help` and `npm ls --omit=dev --json` exited0.
  Existing scripts/cli-smoke.mjs executed with the package as cwd and QA-cache
  TMPDIR, exit0: real CLI init/status/capabilities plus prohibited-command and
  unsupported-GJC rejection checks passed against an isolated SQLite database.
  Runtime imports and better-sqlite3 worked without the checkout's node_modules.
- Evidence: runtime-package-receipt.json, dependency-install.log,
  installed-runtime-dependencies.json, packaged-help.json and packaged-cli-smoke.log
  in that cache directory; build log runtime-package-build.log in its parent.
- This closes the earlier missing db.js reproduction for this experimental
  complete payload. Reusable packaging automation, sealed source/reproducibility
  evidence and packaged dashboard/doctor/provider health gates remain unfinished.
  deployment_ready=false; no production activation or production DB mutation.

### Packaged dashboard and doctor execution — 2026-09-09

- Continued the same runtime-package-7htxb2nv artifact from source2e0aa3f.
  Created and migrated an isolated dashboard-probe.sqlite with packaged AuthorityDb.
  Launched the actual packaged dashboard/main.js CLI on loopback/port0 with its
  packaged dist/dashboard static root. A test-only Node preload blocks child
  process execution so these observations do not establish provider integration.
  Native filesystem readiness probes still observe host executable/config metadata.
- HTTP root200 (1733bytes), JS asset200 (448980bytes), CSS asset200 (26548bytes).
  /api/v1/health200 reports authority=ready and second_brain.readiness=unavailable;
  provider read/write authorization bothfalse. SIGTERM shutdown exit0, stderr0bytes.
  This is HTTP asset/startup validation, not rendered-browser interaction evidence.
- Actual packaged doctor CLI with the same preload exited0:7checks passed,
  Node24.19.0/ABI137, SQLite3.53.2, quick_check=ok, migrations84/84 and checksums
  verified. Its overall ok=true is authority health; provider remains unavailable,
  so this result must not satisfy the release mcp-handshake gate.
- Receipts dashboard-package-probe.json, packaged-doctor.json and
  packaged-doctor.stderr reside in the artifact cache directory. No provider
  process was executed. Full integration verify session93446 was separately
  re-polled and remained live; its worktree was not modified or restarted.

### Repeatable isolated runtime packaging — 2026-09-09

- Added scripts/package-authority-runtime.mjs following the isolated-runtime ADR.
  Explicit scratch parent, fresh mkdtemp output, full build, backend identity match,
  bounded regular-file copy, offline production npm install and existing CLI smoke.
  Input/source/copy identities are checked again before writing the success receipt.
  Failure retains logs and no success receipt; deployment_ready remainsfalse.
- Actual command exit0 at source HEADa030a04 with dirty=true (new script included
  in input digest): jarvis-runtime-KiCZjY in the shared QA cache,1355files/8535984bytes,
  payload digest sha256:9fec5fa0447b718dda76d5e67ffd6eddfdb56ad3b43330319487f413b35d386e.
  A separate post-command receipt/payload recheck passed. Native SQLite smoke
  passed with production dependencies; Electron and backend build lock absent.
- Missing argument and nonexistent parent each exit1. Reused fileIdentity rejects
  an isolated input symlink with BACKEND_BUILD_SYMLINK. Node syntax and diff checks
  passed. Receipt runtime-package-negative-checks.json captures argument failures.
- Fresh native read-only runtime_package_review returned ship/no blocking findings.
  Requested terra/high; actual model/effort unobservable. Remaining limits:
  source checkout supplies smoke harness; installed node_modules is not itself
  hashed by this receipt; no hermetic native build or cross-host portability claim.
- Full verify session93446 remains separate and live. First shard243files/1697tests
  passed; later gates are pending. No operational release pointer was changed.

### Packaged runtime identity acceptance — 2026-09-09

- Rebuilt from committed c3b4eb0: package jarvis-runtime-5hfTNW, CLI smoke exit0.
  Its own runtime.identity reports that exact HEAD, artifact/toolchain matched.
  source_dirty=true remains accurate for the checkout's untracked node_modules.
- Isolated canonical.js comment insertion causes observed artifact mismatch;
  restoring original bytes returns matched. Both CLI invocations exit0 because
  runtime.identity is an observation command, so consumers must check its fields.
  The explicitly absent DB remains absent throughout. Evidence in that artifact:
  packaged-runtime-identity.json and packaged-identity-tamper-check.json.
- Identity against the smoke DB: migrations84, missing0/unexpected0/changed0,
  schema objects1454, build and database statuses matched. Receipt:
  packaged-runtime-schema-identity.json. No operational database was accessed.
- Packager now checks its own CLI's source/input/artifact/toolchain identity and
  absent-DB noncreation before success receipt publication. Actual full packaging
  rerun exit0; identity-gated-runtime-package.json locates the new artifact and
  receipt.validation.runtime_identity=passed. Parent syntax/diff checks passed.
  This small additional validation predicate received parent diff review; the
  base packaging implementation's independent review remains recorded above.

### Runtime package failure-path execution — 2026-09-09

- Actual packager with a fresh empty npm cache builds successfully then fails
  offline dependency installation, exit1; dependency log contains ENOTCACHED once.
  Output jarvis-runtime-ZbhsV5 retains build/install logs, no CLI smoke log and
  no runtime-package-receipt.json. Failure does not become package success.
- Added subprocess failed_step/log filename, exit_code and signal to the existing
  error JSON without embedding command output. Real empty-cache rerun in
  jarvis-runtime-YHSorv yields dependency-install.log/1/null and no success receipt.
  Evidence package-failure-step.json plus runtime-package-empty-cache-failure.json
  in the shared QA cache. This is a real npm failure, not an injected runner result.
- Normal-cache packaging after the change exits0, recorded by
  package-after-failure-fix.json. Parent inspected complete small diff, syntax and
  diff checks pass. Full verify93446 remains live in the unchanged integration
  worktree; no service activation or production DB access performed.

### Completed full gate and retention clock rollback — 2026-09-09

- Full verify session93446 exited0. Backend shards243files/1697tests and
  243files/1726tests, dashboard37files/255tests:3678 total. Fixed-clock acceptance
  and final CLI smoke exited0 as part of canonical verify.
- Integration worktree HEADa184fca458ce2de6e58a4ccd25fd05cd61f4beee unchanged;
  1674 tracked file SHA256 values match the saved pre-run vector, mismatch0.
  verify-task-identity-after.json records the comparison. This proves that gate's
  source identity; later packaging and retention edits are not covered by that run.
- Retention regression before fix:2failed/18passed. Execution could precede its
  persisted claim timestamp, and adapter deletion could settle after a clock rewind.
  Added updated_at/not_before lease guards and completedAt>=started check.
  Related retention/migration suite now2files/21tests passed; full lint,3typechecks
  and backend build exit0. No migration SQL changed.
- Compiled process3982445 with file-backed fixture DB: pre-claim-time execution
  E_RETENTION_CLAIM/calls0 and unchanged claimed row; during-adapter rewind
  E_CLOCK_INVALID/calls1, deletion rolled back (row1 preserved), failed job/null
  result_digest. quick_check=ok. Receipt in shared QA cache
  retention-rewind-live-Hp2881/receipt.json. Real deletion adapters/scheduling remain
  HOLD; test clock and fixture rows are not production deletion acceptance.
- Native read-only retention_rewind_review returned ship. Requested luna/high;
  actual runtime metadata unobservable. Reviewer's direct Vitest collection hit
  scratch error-122; that failed attempt is separate from the parent canonical
  runner21tests and compiled validation above, and is not reported as a pass.

### Scoped provider branch integration — 2026-09-09

- main623afa6 had16 provider-side JARVIS commits absent from development063bcfa;
  development had105 commits absent from main. Merged the exact main commit into
  the isolated development worktree; user main/provider checkouts were not edited.
- Resolved6 textual conflicts by retaining the scoped API barrel and central
  transport profile validator while adding readv3–v5/writev1. Gateway provider
  verification now has a focused HTTP handler; cookie refresh remains in the
  existing authentication module with the same call sites and session checks.
- First integration run:231passed/1reviewability failure. Expanded long lines
  and extracted domain behavior without weakening250line/160column checks.
  Final focused suite37files/325tests passed, including gateway, scoped settlement,
  compaction and task suppression. Full lint,3typechecks and complete build exit0.
- Both source migration vectors preserved byte-for-byte:84files from063bcfa,
  80files from623afa6, merged86files. Four new frozen contract files match provider.
  Evidence scoped-merge-byte-preservation.json in shared QA cache.
- Actual merged build→separate Python MCP→TLS/gateway current session→provider CLI
  acceptance exit0: valid accepted→proved/HTTPS5; revoke-during-admission denied/no
  accepted row/HTTPS2; revoke or expiry before execution failed/no active generation/
  HTTPS3 each. Every case dispatch attempts1/FKerrors0. Fixture clock, CA and identity
  forwarder; not operational A→B or production activation acceptance.
  Receipt scoped-merged-mcp-acceptance.json, stderr0bytes.
- Separate full verify7547 ended exit2/TEST_RUN_TIMEOUT on shard2. Shard1 passed
  243files/1697tests. Before/after vectors prove HEAD063bcfa and all1677 tracked
  files unchanged; this incomplete gate cannot certify the integration. The last
  logged GJC suite passed independently25/25 in20.02s; the timeout cause remains
  unproven (verify-timeout-gjc-isolated.log).
- Review correction: historical reconciliation now checks candidate/outbox current
  suppression before reading private spool bytes. Fresh regression6files/37tests,
  lint/typecheck/build, CLI smoke and fixed-clock acceptance exit0. Compiled Node24
  fixture separately blocked4 paths for each of candidate/outbox quarantine,
  write_delta0, preserved settlement1, quick_check=ok. Evidence:
  scoped-replay-suppression-compiled.json. This does not prove production lineage.
- Final merged-source regression rerun after the correction:37files/327tests,
  exit0,179.05s (tool session43559). No test paths were removed from the prior
  37file integration selection; the two quarantine cases increase325 to327.
- Independent review returned fix-first for migration079/080 filename collisions
  missing from the exact allocation allowances. Parent reproduced2failed/2files
  (allocation and protocol compatibility), then allowed only the two committed
  immutable filename pairs:2passed/2files. Fresh lint/typecheck exit0. No SQL edited.
  Actual compiled migration probes upgraded both original parent DB vectors84/80
  to86, preserved every prior journal row, repeat writes0/FKerrors0/quick_checkok.
  Receipt: scoped-migration-upgrade-qjIJ8c/receipt.json in shared QA cache. Empty
  isolated DBs; not production upgrade acceptance.
- Fresh independent scoped_integration_review returned ship/finding0 after its own
  exact2file/2test pass, parent SQL byte comparison84/80 with0mismatches, and
  unresolved-index0/diff-check0. Full gate and production holds remain unchanged.

### Self-contained packaged CLI validation — 2026-09-09

- Packager now includes scripts/cli-smoke.mjs in its copied/hashed/rechecked roots
  and executes the output copy. The former absolute source-harness dependency is
  removed; no additional developer script tree or dependency is included.
- Actual full package command exit0: source5c186e4 dirty=true,1393payload files,
  jarvis-runtime-BpApfW under shared QA cache. Build, offline production install,
  copied CLI smoke and runtime identity passed; deployment_ready=false.
- Independent rerun used bwrap to hide both canonical JARVIS source and all JARVIS
  workspaces, unshare network, and run only packaged scripts/cli-smoke.mjs with
  private scratch. Exit0/stdout0bytes/stderr0bytes. Receipt in the package:
  independent-smoke-receipt.json. This is same-host CLI validation, not provider,
  browser, hermetic dependencies, or production deployment acceptance.
- Parent reviewed the two-line executable change; node --check and diff --check
  exit0. No new test duplicates the existing executable CLI smoke.

### Shared test schema and race cleanup budget — 2026-09-09

- Completed older063bcfa shard2 diagnostic:243files,1727passed/1failed,908.82s,
  exit1. One memory-candidates-concurrency case exceeded the outer5000ms timeout.
  Before/after hash comparison still shows1677files unchanged. The worker itself
  has a5000ms deadline, leaving no outer setup/cleanup allowance. Give only this
  suite15000ms, preserving worker deadline and every race assertion.
- Generalized the existing connector schema image pattern into one private test
  helper. Build a real uninitialized schema, serialize it, then create independent
  exclusive0600 files. Bind cache to directory/filename/SQL bytes, recheck after
  preparation, invalidate changed input, and never cache keys or test mutations.
  initialized()/memoryDatabase() still initialize with fresh anchors and policy keys.
  Connector fixture delegates to this helper and retains readiness validation.
- Earlier file-copy variant passed4files42tests; broad38files329tests in103.57s
  versus prior37files327tests179.05s. The scopes/load differ; this is not a controlled
  full-suite speed ratio. Final serialized consolidation passed4files14tests15.93s,
  including original full seed-data equivalence, FK/integrity and actual migration
  tests. Lint/3typechecks/backend build exit0. Logs schema-fixture-* in shared QA.
- Final compiled helper five calls:497.74ms initial construction, then28.32–34.94ms;
  distinct keys5/paths5, candidates0, FKerrors0, quick_checkok. Receipt:
  schema-fixture-final-cCAZMt/receipt.json. No production code, schema migration,
  runtime permission or test assertions were removed. Latest full gate remains due.
- Independent schema_fixture_cache_review returned SHIP/no fix-first findings.
  Requested terra/high; actual runtime model metadata unavailable. It checked
  final code and physical log/receipt evidence. Residual file changes after the
  final synchronous identity read are outside the tested preparation window;
  production paths do not use this fixture.

### Latest merged dashboard browser acceptance — 2026-09-09

- `npm run test:e2e` at a6c6988 completed exit0,26/26passed in1.2m. Both real
  Chromium viewports1440x1000 and1024x768 exercised overview, Korean text, task
  graph/list, secret redaction, empty DB, no-write preview, staging, invalid
  receipts, signed approval/execution and rejection, cancel, retry, and expired
  workflow replanning. Console-error assertions and serious/critical axe plus
  horizontal overflow checks passed in both viewports.
- Built backend/dashboard and launched actual isolated fixture HTTP servers with
  reuseExistingServer=false. This run made no real model call, used seeded
  authority data, and did not alter an operational service or production DB.
  Viewed the1024px overview screenshot; preserve the automated layout assertions
  as the measurable result rather than declaring overall UI quality from an image.
- Archived16screenshots and passing last-run metadata under shared QA cache
  scoped-integration-browser-1w2lwv7a/receipt.json; log scoped-integration-e2e.log.
  Full canonical verify91507 remains separate on frozen a6c6988 with1735tracked
  files captured before execution; final gate completion is still unproven.

### Installed runtime dependency identity — 2026-09-09

- The isolated packager now records every installed dependency file, directory,
  mode and relative symlink target, including manifest-named files. It reuses the
  release walker with a distinct digest domain and checks the dependency identity
  after install and again after CLI/runtime checks. Existing release exclusions
  and payload digests are preserved. This is an unsigned local snapshot.
- Parent lint/typecheck and actual build/package command exit0. Focused manifest
  and release rehearsal regression:2files9tests passed. Actual package
  jarvis-runtime-oTABz3 contains2843dependency entries,2527files,3symlinks,
  32691716bytes. File-content and executable-mode mutations changed the identity;
  restoring original bytes/mode restored the digest.
- Independent bwrap CLI smoke hides canonical source and all JARVIS workspaces
  and unshares network:exit0. Dependency identity matched afterward. Old frozen
  compiled release manifest and new manifest JSON matched on an isolated fixture
  with root/nested manifest names and a relative link. Artifacts in shared QA:
  package-dependency-{actual-acceptance,compatibility}.json and build/test logs.
- Production activation and reproducibility remain unverified; deployment_ready
  stays false. Full verify91507 remains separate on frozen a6c6988.
- Fresh runtime_dependency_review returned ship,0findings; requested terra/high,
  actual model/effort unobservable. It reviewed the implementation and QA evidence.

### Scoped-contract build fixture completion — 2026-09-09

- Live full verify91507 exposed9backend-build failures: the isolated build fixture
  lacked newly merged scoped writev1 and readv3/v4/v5 contracts. Its explicit
  copy/expected-output vector now includes those4contracts and SHA sidecars.
  Production copier and assertions are unchanged.
- Red evidence: verify-schema-fixture-full.log, ENOENT for scoped-write-v1.json.
  Focused replay after fixture correction:1file10tests passed,6.02s,exit0.
  Syntax and diff checks exit0; parent reviewed the two-line fixture change.
- Full gate also reports policy-binding explicit-restart5000ms timeout and real
  MCP-process180000ms timeout. A focused unchanged-assertion replay is running
  separately; no timeout increase or completion claim is made from these failures.
- Focused timeout diagnostic completed exit0:2files76tests,31.98s. Policy-binding
  75tests passed in8.90s; actual built MCP lifecycle passed in19.36s. The timeout
  failures did not reproduce in this run. This does not prove the full gate passes
  or establish a root cause for the earlier stall; keep full-gate failure visible.

### Same-host complete package repeat and full gate result — 2026-09-09

- Completed two independent fresh package directories at43fc8e7113cd5d1e8c595afffc8a34626b81f382:
  jarvis-runtime-jtPFtm and jarvis-runtime-vejWFA under shared QA. Both full build,
  offline npm ci, CLI smoke and no-DB runtime identity exit0. Source dirty=true
  (checkout has untracked node_modules), Node24.19.0/ABI137/Linux x64/TS5.9.3.
- Source identities equal,1395payload files equal,2843dependency entries equal;
  differences0in both vectors. Independently rehashed both directories from disk
  and matched each receipt. Evidence:runtime-repeat-comparison.json and the two
  runtime-repeat-{first,second}.json outputs. Logs/temporary smoke state are outside
  these vectors. Same host/toolchain/cache only; no hermetic or cross-host claim,
  signatures, activation or production data changes. Both deployment_ready=false.
- Prior frozen a6c6988 verify91507 ended exit1:shard1 1741pass/9fail across250files;
  shard2 1779pass/3fail across249files. Input vector1735files unchanged before/after.
  Fixture missing4contracts fixed in43fc8e7; focused10tests passed. Three timeouts
  were policy binding, real MCP lifecycle, and reopened task operation. First two
  focused76tests passed previously; third focused18tests now passed in4.13s.
  No timeout changes were made; the earlier stalls' cause remains unproven.
- After observing prior process exit, fast-forwarded the isolated integration tree
  to43fc8e7 and started canonical npm run verify6691. Captured1735tracked file hashes
  in verify-runtime-dependencies-before.json; output in
  verify-runtime-dependencies-full.log. This run is pending, not a passing gate.

### Canonical gate on runtime-dependency baseline — 2026-09-09

- verify6691 completed exit0 at43fc8e7113cd5d1e8c595afffc8a34626b81f382.
  Backend shard1:250files1750tests; shard2:249files1784tests; dashboard:37files255tests.
  Total3789tests passed. Canonical runtime check, lint, typecheck, build, fixed-clock
  acceptance and CLI smoke completed in the npm run verify command.
- Captured1735tracked file hashes before/after with0changes and unchanged HEAD.
  QA evidence:verify-runtime-dependencies-{before,after,result}.json and
  verify-runtime-dependencies-full.log. This closes the earlier baseline gate
  failure; it does not explain prior timeouts or cover later timeline edits.
- Current timeline ID-set work is separate and uncommitted pending independent
  review. Reviewer timeline_id_set_review failed to start due to tool-reported
  usage limit (retry time15:25). No review verdict or product completion is claimed.

### Timeline SQL parameter-limit closure — 2026-09-09

- Reproduced too many SQL variables with2000connected intents and separately
 40000control references in negative evidence. Replaced ID-per-placeholder queries
 in graph/query/summary/negative-evidence readers with bound JSON-array IN queries.
 Existing filters/order/empty behavior retained; no migration/write changes.
- Focused19tests and lint/typecheck/build passed. Actual compiled graph100kintents
 returned all100kIDs with14queries,5samples1002.98–1086.66ms,0writes/FKerrors.
 BuiltCLI2000connected intents returned200events,exit0,stderr0,no DB commit observed.
- Independent luna/max review ship/no findings; actual model metadata unavailable.
 Previous terra usage-limit failure did not constitute a review. Optional CodeRabbit
 install failed on filesystem quota; no CodeRabbit result claimed.
- Full canonical verify71580 exit0:backend250files1748tests +250files1787tests;
 dashboard37files255tests, total3790passed.1737source files unchanged before/after.
 Evidence and scope in docs/planning/adr-timeline-id-sets.md and shared QA receipts.
- Remaining performance work is measured:full100k-intent timeline returns200events
 with500024queries/6786.16ms. Per-record event lookups remain; this commit does not
 claim their removal or whole-backlog completion.

### Batched GJC timeline events — 2026-09-09

- Replaced four child reads per GJC intent and one control-event read per graph ID
  with set queries, preserving parent/category/key ordering and first-event wins.
- Related4files20tests passed, lint/typecheck/backendbuild exit0. Compared compiled
  prior a1a28f8 collectors and new collectors on identical2k/10k/100kfixtures:
  complete returned JSON hashes equal, writes0. Populated7event fixture also equal
  including question/state-ID collision and dual-key control events.
- At100kintents queries500024->28, paired time6874.33->2131.21ms. Five new samples
  p50=2149.77ms/sample p95=2157.12ms; not a production SLO. Actual CLI exit0,
  200events,2546.64ms,stderr0,no independent data_version change.
- Independent timeline_batch_review ship/no findings, requested sol/high, actual
  metadata unavailable. Reviewer extra test invocation was rejected by npm; no
  extra test pass claimed. Parent QA evidence remains20tests and compiled receipts.
- Dense-child peak memory is unmeasured; retaining batched raw rows may increase it.
  Non-GJC per-record queries remain. ADR:adr-timeline-event-batches.md; QA receipts
  in timeline-batch-compare-8FpTMB. Earlier3790test full gate predates this change;
  this unit has targeted acceptance and does not claim a new full gate.

### Dense timeline child measurement after 2700fda

- Synthetic populated fixture + 100,000 child events (1,035-byte JSON each):
  old/new separate-process runs exited 0, identical 200-event output SHA, 0 writes.
- Peak RSS: 453,840 -> 464,096 KiB; elapsed: 540.19 -> 553.74 ms, single samples.
- Query batching does not bound memory before final slicing. Bounded-memory
  collection remains incomplete; production activation is not established.
- Detailed method, limits and QA receipt are in
  `docs/planning/adr-timeline-event-batches.md`.

### Canonical gate for timeline event batching

- `npm run verify` at cfaacc6b4dbe2247d9cee436acf70268340100db exited 0.
- Backend shards: 250 files / 1,749 tests and 250 files / 1,787 tests.
  Dashboard: 37 files / 255 tests. Total: 3,791 passing tests.
- Runtime check, lint, typecheck, build, fixed-clock acceptance and CLI smoke
  completed in the canonical command. All 1,738 tracked file hashes unchanged.
- Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-timeline-batch.log`,
  `verify-timeline-batch-before.json`, `verify-timeline-batch-result.json`.
- This gate predates the prepared top-k collection patch; it does not validate
  that patch or establish production activation.

### Retained timeline tail implementation

- Keeps only requested sorted tail payloads while preserving first ID occurrence,
  stable equal-key ordering and original fractional/NaN slice behavior.
- Parent verification: lint/typecheck/backend build exit 0; 5 files / 22 tests pass.
  Unicode equal-key regression failed in the draft and passed after correction.
- Actual compiled dense fixture output unchanged, 200 events, 0 writes; CLI exit 0,
  0 stderr bytes, independent data_version unchanged. Single-sample max RSS
  396,124 KiB; raw-row and ID memory remain unbounded.
- Details: `docs/planning/adr-timeline-retained-tail.md`. Native review ship/no findings;
  prior canonical gate does not cover this implementation.

### Configured daily service execution

- service run/once now composes concrete stored morning and signed native-evening
  execution when both existing config and key are supplied. Independent phase
  startup/cycle and errors; no overlapping cycle; staged channel rejects daily config.
- Final executable lint/typecheck/build 0; related 6 files / 46 tests passed.
  Final service file expanded to 6 passing regressions including staged rejection
  and missed recovery. Native independent review ship/no findings.
- Actual compiled 6-cycle service + 3-cycle restart: morning/evening completed once,
  1 native publication, unchanged daily run rows after restart. Synthetic clock/key.
- Full gate, provider refresh, retention composition and production activation
  remain pending. See docs/planning/task-daily-service-composition.md for evidence.

### Canonical acceptance for configured daily service

- `npm run verify` at bc035f44112b13bf5152715a42ab1a5707d863fd exited 0.
- Backend shards: 251 files / 1,752 tests and 251 files / 1,792 tests.
  Dashboard: 37 files / 255 tests. Total 3,799 passing tests.
- Runtime, lint, typecheck, build, fixed-clock acceptance and CLI smoke completed.
  All 1,743 tracked-file hashes unchanged through the gate.
- QA: /home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-daily-service.log,
  verify-daily-service-before.json and verify-daily-service-result.json.
- Direct retention-to-file-cleanup composition remains HOLD: isolated reproduction
  produced MEMORY_REVIEW_CLEANUP_TRANSACTION_ACTIVE, then E_RETENTION_ADAPTER and
  a failed job before filesystem access. Receipt: retention-cleanup-composition.json
  in the same QA root. Preserve both existing transaction guards.
- Refresh integration requires run completion tied to the active published generation,
  protocol, capped state and source scope. Current Second Brain source c0e99ee records
  run completion in staging before activation. Four source hashes and requirements
  saved in daily-refresh-integration-boundary.json in QA. No provider changes made.
- Full backlog 01–25 remains active; refresh/retention implementation and production
  activation are not established by this canonical gate.

### Integration prerequisite audit — 2026-09-09

- Development HEAD: 928f1342f301c62bdf1292f175b36903b1e8392b.
  Local main: 70d04285e59b3cc49ba523146a3497960dc22d4a.
- `git rev-list --left-right --count main...HEAD`: 12 / 121.
  Worktree status: 0 tracked changes, 1 untracked node_modules entry.
- Non-checkout `git merge-tree --write-tree HEAD main` exited 1, producing
  candidate tree 424ba325eb6a75346cc9d9a64af2ee765cf54eff and six content conflicts:
  src/index.ts, src/phone-gateway-owner.ts, src/second-brain-frozen.ts,
  src/second-brain-transport-contract.ts, src/second-brain-transport.ts,
  tests/integration/memory-cancellation-db.test.ts. No merge was applied.
- Main-only changes span 60 files, 2,592 insertions and 46 deletions relative to
  the common ancestor, including scoped journal recovery, gateway reconciliation,
  authenticated memory clients, migration readiness and recovered migration 028.
- Next integration unit must preserve both branches' scoped memory contracts,
  reconcile gateway ownership and cancellation behavior, and check recovered SQL
  against its historical-byte evidence without rewriting shipped migrations.
  Dependency lock and packaging changes also require runtime fixture verification.
- The 3,799-test gate covers the development implementation before integration;
  it is not evidence for the candidate tree. Integration, focused contract tests,
  independent review and a subsequent canonical gate remain required. Full backlog
  01–25 is unchanged; no production activation or completion is claimed.

### Main integration implementation and acceptance

- Integrated main 70d04285e59b3cc49ba523146a3497960dc22d4a into development
  e338efccbcd4b3e37e85f1cdf4107ecc6b77007a. Six textual conflicts resolved,
  preserving extracted APIs, scoped status/read/write profiles and cancellation guards.
- Gateway provider verification now awaits migration readiness and rechecks the live
  session. Extracted reconciliation route retains authorization, CSRF and capacity checks.
- Public createPhoneMemoryClientMcp is asynchronous and loads the optional SDK on
  demand. Its dedicated executable/direct factory stays unchanged. Eager SDK import
  initialized node:process stdin, causing the synchronous lock fixture to throw EAGAIN;
  lazy loading restores the original two-process winner/loser and busy-timeout checks.
  The child exit observer also handles a child that already exited; no timeout extension.
- Recovered migration 028 remains byte-identical (SHA256 55faa41aa1c3c0b2c78ebfa4f59cd9daf6e4793deac91f39bfb3ea7e00955386).
  Updated fixture vectors explicitly retain both 028 filenames. The original 36-file
  baseline digest is unchanged; the recovered file is pinned separately. Unknown
  migration histories still fail readiness. No shipped SQL bytes were rewritten.
- Initial canonical attempt was interrupted after reproducible failures: exit130,
  1780 tracked hashes unchanged. Revised full backend execution ended exit1:
  shard1 1789 pass/2 fail; shard2 1826 pass/2 fail. All four remaining failures were
  stale migration fixture expectations, corrected afterward. Focused migration
  verification: 5 files/12 tests pass. Earlier import/doctor/progress fixes: 4 files/29 pass.
- Final lint/typecheck exit0. Product build exit0 (1317 artifacts,87 migrations).
  Separate remaining gate stages passed: dashboard37 files/255 tests, fixed-clock
  acceptance, CLI smoke. These results do not relabel the failed canonical command
  as passed; an uninterrupted canonical gate on the final commit remains pending.
- Actual compiled HTTP login -> separate Python MCP acceptance passed for pending,
  failed and proved with synthetic authority/policy/clock. Independent restart kept
  attempts1, acceptance event1 or settlement1, FK0; completed replay provider calls0.
  Pending/failed remain reconciling; proved reaches candidate/outbox settled and control
  completed. Test receipts predate the lazy import correction; subsequent public MCP
  HTTPS test passes using the corrected public factory.
- Isolated production installation: npm ci --omit=dev --offline exit0,161 packages;
  CLI smoke and awaited public MCP factory creation/close exit0. No deployment.
- Native full integration review returned ship/no findings. Four test-only fixture
  corrections received incremental ship/no findings. Runtime model/effort metadata
  and token usage were unavailable for both reviews.
- Evidence root: /home/jm/.cache/jarvis-test-runtime-qa-20260908. Files:
  verify-main-integration-fixed-result.json, main-integration-migration-fixes.log,
  main-integration-dashboard.log, main-integration-acceptance.log,
  main-integration-smoke.log, main-integration-http-summary.json,
  main-integration-prod-deps-result.json. Full backlog01–25 remains active, including
  retention/refresh composition and actual operational activation.


## Integrated commit canonical acceptance — 2026-09-09

- Tested commit: `a2e685c9c42364a7cc2caf1c971c115adf4d173b`.
- Uninterrupted `npm run verify`: exit 0 (session 23860).
- Backend shard 1: 256 files, 1791 tests passed, 567.97 seconds.
- Backend shard 2: 256 files, 1828 tests passed, 525.59 seconds.
- Dashboard: 37 files, 255 tests passed, 34.24 seconds.
- Total: 549 test-file executions, 3874 tests passed. Runtime check, lint,
  typecheck, build, fixed-clock acceptance and CLI smoke completed in the gate.
- Fixed-clock acceptance: pre_gjc_ready, aggregate_status stopped,
  completion_promoted true, gjc_dispatched false.
- Before/after hashing: 1780 tracked files, changed_files [].
- Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-main-integrated-commit.log`,
  `verify-main-integrated-commit-before.json`, `verify-main-integrated-commit-result.json`.
- This completes canonical verification of the integrated development commit.
  It does not prove production activation or completion of backlog 01–25.
  Actual retention adapters and refresh integration remain open; the previously
  documented unsafe file-cleanup transaction composition remains on hold.


## Candidate review service timer acceptance

Commit d7ebb92: isolated compiled CLI service run executed twice with7 ignored files,
limit2 and25ms timer. Each process emitted2 changed-state cleanup rows and completed
its traversal; unchanged intermediate results were suppressed. Both terminated via
SIGTERM, and the reopened fixture database had0 foreign key violations. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/service-cleanup-timer-live.json.
Default signal termination does not prove graceful finally execution. Candidate
file deletion remains covered by the separate compiled CLI integration test.
Backlog01–25 remains open, including broader retention, refresh and production use.


## Cleanup service canonical acceptance

- Tested commit fea01e67b2953d87b3a8ddbf400b481e48d9da8b.
- First canonical session87727 ended143 without a result receipt; process inspection
  found no remaining matching verifier. Cause unconfirmed. That run is interrupted,
  not passed. Before restarting, all1785 tracked file hashes were unchanged.
- Retry session7894: uninterrupted npm run verify exit0.
- Backend shard1:257files1794tests passed,569.37s; shard2:257files1832tests passed,514.73s.
- Dashboard:37files255tests passed,33.57s. Total3881tests passed.
- Runtime check, lint, typecheck, build, fixed-clock acceptance and CLI smoke passed.
  Acceptance returned pre_gjc_ready/stopped, completion_promoted true, gjc_dispatched false.
- Before/after tracked hashes:1785files, changed_files [].
- Evidence directory: /home/jm/.cache/jarvis-test-runtime-qa-20260908.
  verify-cleanup-service-interruption.json, verify-cleanup-service-retry.log,
  verify-cleanup-service-retry-result.json, verify-cleanup-service-before.json.
- This verifies the current candidate cleanup implementation. Broader retention,
  provider refresh, operational activation and the remaining backlog01–25 are open.

## Main follow-up integration (195b1a7)

Integrated five main commits through 195b1a7 into development d14dd6c. Three
conflicted files resolved by retaining development runtime-dependency hashing and
main root-only release-manifest exclusion, both test sets, and expanded memory MCP
evidence/omission guidance with the existing lazy public SDK-loading boundary.
Dependency-reuse preflight and bounded portfolio stdin were also incorporated.

Focused validation: unit3files20tests and integration3files22tests passed. Typecheck,
zero-warning lint and backend build exited0. Integration includes isolated release
rehearsal, actual compiled portfolio CLI and phone-memory client behavior. A compiled
probe additionally verified that changing a root manifest-named file changes the
runtime dependency digest (entry_count1), preserving the false-exclusion mode.
Logs: /home/jm/.cache/jarvis-test-runtime-qa-20260908/main-five-unit.log and
main-five-integration.log. Production publisher/service/current were not activated.
Canonical gate on this integration is pending; earlier3920-test gate predates it.

Independent read-only review by /root/refresh_receipt_review returned ship.
Reviewer measured unmerged entries0, conflict markers0 and diff-check0. Parent
read back completed logs confirming unit20 and integration22 before commit.
Observed reviewer model/effort and API-equivalent token cost are unavailable.

## Main integration canonical acceptance

- Tested commit 32d0774f7bd6575a1083d2d83f7a05ac2a2a4431, session33596, npm run verify exit0.
- Backend shard1:262files1828tests passed,588.76s; shard2:261files1849tests passed,537.03s.
- Dashboard:37files255tests passed,33.65s. Total3932tests passed.
- Canonical runtime/lint/typecheck/build/tests/fixed-clock acceptance/smoke chain exited0.
- Acceptance: pre_gjc_ready/stopped, completion_promoted true, gjc_dispatched false.
- Before/after hashes:1817 tracked files, changed_files [].
- Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-main-five.log,
  verify-main-five-before.json and verify-main-five-result.json.
- No production deployment or service restart. Recurring collection and remaining backlog01–25 remain open.
- API-equivalent cost unavailable: per-call token usage/model pricing scope not observed.

## Local timeline collection canonical acceptance

- Tested commit 9730830480cec438ba5c24ab7d74aba55e3f771a, session2748, npm run verify exit0.
- Backend shard1:264files1832tests passed,600.26s; shard2:263files1859tests passed,546.46s.
- Dashboard:37files255tests passed,33.51s. Total3946tests passed.
- Runtime/lint/typecheck/test build/tests/fixed-clock acceptance/CLI smoke chain exited0.
- Acceptance: pre_gjc_ready/stopped, completion_promoted true, gjc_dispatched false.
- Before/after hashes:1827 tracked files, changed_files []. Finished 2026-09-09T14:40:13.516614+00:00.
- Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-local-timeline.log,
  verify-local-timeline-before.json and verify-local-timeline-result.json.
- Covers the committed local timeline producer, bounded snapshot lifecycle, CLI and opt-in service collector.
  Separate compiled-process usage evidence and limitations are recorded in docs/local-timeline-snapshots.md.
- Local snapshots are not verified Linux live evidence or completed provider refresh receipts.
  Their use as morning recommendation provenance remains deferred until an explicit consumer contract is implemented.
- No production deployment or service restart. Remaining backlog01–25 completion is not established by this gate.

## Local service collection discovery

- Added read-only timeline subjects CLI inventory: automatic service output contains counts,
  while snapshot requires an exact collection ID. Users can now discover that cached ID without direct SQL.
- Inventory exposes at most64 registered subjects with hold/ID/expiry metadata, not a freshness verdict.
  Exact snapshot reads still revalidate current source, expiry and replacement identity.
- Typecheck, zero-warning lint and backend build exited0. CLI/service/reviewability3files7tests passed.
- Separate compiled CLI processes: register -> service once -> subjects -> exact snapshot returned ready.
  Four processes, one subject, database bytes unchanged across the two reads; isolated fixture database.
- Parent inspected complete diff; this bounded read-only CLI addition did not use delegated review.
  Prior3946-test canonical gate predates this addition. No production activation.
- API-equivalent cost unavailable: per-call token usage and runtime pricing scope not observed.

## Retention creation schedule validation

- Five new regression cases failed before the change: four returned raw SQLite constraint errors,
  and a job already expired at its creation timestamp was inserted successfully.
- createJob now checks canonical notBefore/expiresAt and requires expiry strictly after
  both notBefore and createdAt before inserting. Existing migration bytes are unchanged.
- Retention runtime, remote audit adapter/service and reviewability:4files41tests passed.
  Typecheck, zero-warning lint and backend build exited0.
- A separate compiled Node process rejected creation at expiry with unchanged database bytes,
  then created, claimed and completed a valid job using an isolated empty-scan adapter.
  This verifies the runtime lifecycle, not production deletion or a new retention adapter.
- Parent inspected the bounded validation diff. No delegated review or production activation.
  General retention integration and the full backlog remain open.

## Subjects and retention canonical acceptance — 2026-09-10 KST

- Tested commit ce8df874c8f12b1c1df346bbb8384a55cd4850f8, session69028, npm run verify exit0.
- Backend shard1:264files1832tests passed,598.45s; shard2:263files1864tests passed,542.64s.
- Dashboard:37files255tests passed,33.89s. Total3951tests passed.
- Runtime/lint/typecheck/test build/tests/fixed-clock acceptance/CLI smoke chain exited0.
- Acceptance: pre_gjc_ready/stopped, completion_promoted true, gjc_dispatched false.
- Before/after hashes:1827 tracked files, changed_files []. Finished 2026-09-09T15:09:17.680006+00:00.
- Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-subjects-retention.log,
  verify-subjects-retention-before.json and verify-subjects-retention-result.json.
- Includes read-only local collection discovery and retention schedule validation.
  No production deployment, provider refresh promotion or general retention activation.
  Full backlog completion remains unproven; this gate validates the tested implementation only.

## Work lineage and projection indexes — canonical gate, acceptance pending

- Tested product commit a951729f781e86e6371a93e74dcb06773af76158; npm run verify exit0.
- Backend:266files1838tests +265files1871tests; dashboard37files256tests.
  Total568files3965tests. All1843 tracked hashes unchanged during the gate.
- Browser:28tests passed across1440/1024,1.3minutes, local HTTP fixture servers.
- Fixes include explicit signed original/rework/retry declarations, generic staging
  binding, bounded predecessor visibility, approval-page suppression, task identity
  snapshot/replay and internal uncertain settlement after mid-execution quarantine.
- Migration086 adds projection_id indexes; prior92 migration files are unchanged.
  Detailed scale and upgrade evidence: docs/planning/projection-id-index-evidence.md.
- Fresh read-only review /root/indexed_lineage_review is running; no accepting
  verdict yet. Feature evidence: docs/task-work-lineage.md. No production activation.
- Backlog25 remains incomplete: task-usage-performance reports client estimates,
  billing_verified=false. Billing-backed cost, reconciled external duplicate effects
  and executed candidate outcome comparison remain unavailable, not measured zero.
- Backlog16 remains incomplete: generic command list still materializes all rows.
  Identifier indexes do not implement generic CLI pagination or close all capacity work.
- The original backlog01–25 and earlier operational/retention/consumer holds remain
  in scope; this feature gate is not a full-goal completion claim.


### 2026-09-10 — packaged dashboard HTTP verification

- Added `scripts/packaged-dashboard-http-probe.mjs PACKAGE_ROOT [RECEIPT_PATH]`.
  It migrates a private SQLite DB with the supplied package, launches the packaged dashboard
  on loopback port 0 with a minimal environment, and stops the child before deleting scratch data.
- Tested artifact: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/jarvis-runtime-GbXulG`,
  source `4abe9c0a6e7d4e8e0c996fc5bf62cfcc14c2464d` (`dirty=true` in its receipt).
- HTTP 200: `/` 1,733 bytes, JavaScript 451,790 bytes, CSS 26,548 bytes,
  `/api/v1/health` 1,161 bytes. All three static responses equal packaged file bytes;
  health reports `status=ok`, `authority=ready`; SIGTERM shutdown exits 0.
- Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/packaged-dashboard-http.json`.
  This is supplementary evidence; the original package receipt remains unchanged.
- Scope excludes browser interaction, provider/model execution, and production activation.
  `deployment_ready=false` remains applicable; the full backlog is not complete.


### 2026-09-10 — production proposal composition defect

- Actual packaged Chromium interaction reproduced HTTP 404 / NOT_FOUND for
  POST /api/v1/proposals/preview. The real startDashboardCli supplied a capability
  probe but omitted the planner; fixture servers supplied both. Connected existing
  planTeamProposal at the production composition root, restoring preview and staging.
- Added a real-entrypoint HTTP regression: preview returns ready with the entered
  constraints/evidence and the observing connection PRAGMA data_version is unchanged.
  dashboard-cli + dashboard-proposal: 2 files / 9 tests passed. typecheck, zero-warning
  lint, backend build and isolated package creation exited 0.
- Fixed package: /home/jm/.cache/jarvis-test-runtime-qa-20260908/jarvis-runtime-DeVFyt.
  Its source receipt records HEAD5076232 with dirty=true and input digest
  sha256:f733e3e245f0782562eb9443b6234482e59dcd2cb6ae31adbee011523760ba5e.
- Browser plugin not available; used installed Playwright Chromium. First launch
  with /tmp failed SIGTRAP; explicit QA TMPDIR allowed browser launch. Original
  package reproduced the 404; fixed package passed overview empty states, title,
  proposal preview and requirement display at 1440x1000 and 1024x1000. Both had
  console/page errors0, Vite overlays0, horizontal overflow0. At1024 Stage task
  created a pending workflow.start request. No approval or provider execution.
- Temporary script, JSON receipt and screenshots reside outside the repository at
  /home/jm/.cache/jarvis-test-runtime-qa-20260908/packaged-dashboard-browser* and
  packaged-dashboard-{1440,1024}.png. Screenshot shows disconnected SSE status;
  this is not evidence of healthy live updates. No mobile or other browser coverage.
- This repairs a real entrypoint/fixture mismatch; full backlog01–25 and deployment
  remain incomplete. Original package is not patched or promoted.
- Follow-up compiled dashboard-cli5/5 and dashboard-task-create8/8 passed;
  distinct focused coverage is17tests across3files. Independent review verdict SHIP,
  findings0: preview/staging preserve CSRF, digest and separate approval gates.


### 2026-09-10 — initial live-update status clarification

- Rechecked the unchanged DeVFyt package with an explicit live-status wait:
  Chromium1440/1024 both reached 연결됨. The earlier screenshot captured startup;
  it did not establish a persistent SSE outage. Evidence: QA packaged-dashboard-sse.json.
- createDashboardStore.start now publishes connecting while session/snapshot reads
  precede EventSource creation. OperationalShell labels it 연결 중 with the existing
  amber connecting indicator. Session failure still yields offline; EventSource error
  still yields reconnecting. No authority is granted by the added state.
- Added startup-hydration and rendered-label assertions; existing session-failure
  test now waits for its terminal offline state rather than the first notification.
  Full dashboard37files/261tests, typecheck, zero-warning lint and dashboard build passed.
- Built-checkout real HTTP/Chromium validation delayed (not fabricated) the session
  response and asserted 연결 중 then 연결됨 at1440/1024. Preview remained Ready with
  constraints/evidence preserved;1024 staging produced pending workflow.start.
  Console/page errors0, Vite overlays0, horizontal overflow0; shutdown exit0.
- QA artifacts: dashboard-connecting-probe.mjs, dashboard-connecting.json,
  connecting-{1440,1024}.png and connected-{1440,1024}.png under
  /home/jm/.cache/jarvis-test-runtime-qa-20260908. Browser plugin absent; installed
  Playwright used with explicit private TMPDIR. Parent inspected all6changed files.
  No provider execution, production change, mobile check or sustained SSE outage
  recovery is claimed by this startup-only verification. Full objective remains open.


### 2026-09-10 — preserve projection identity during concurrent startup

- Dashboard projectionKey previously read ENOENT then wrote without exclusive creation.
  Two startups could retain different in-memory keys after overwriting one shared file.
  Creation now uses wx; EEXIST reads the already published32-byte key. A partial/wrong-size
  winner is rejected without replacement. Existing key bytes and mode are not rewritten.
- Deterministic filesystem interleaving tests publish another startup's real file between
  missing-key read and attempted creation. Complete winner32bytes is reused; empty winner
  is preserved with VALIDATION_ERROR. Normal creation/restart retains the private key.
  New3tests plus existing outbox5tests passed. Initial ESM spy setup failed2tests; a copied
  module namespace fixed the test harness before the8test pass. lint/backend build passed.
- Compiled real-process probe synchronized8children after imports/DB opens, then released
  all startup calls.8succeeded,0partial-file rejections, all8returned keys matched disk;
  provider calls0. QA projection-key-process-probe.mjs and projection-key-process.json
  under /home/jm/.cache/jarvis-test-runtime-qa-20260908. No key bytes logged.
- This change addresses concurrent creation, not key rotation, adversarial filesystem
  replacement or power-loss durability. A startup observing an incomplete writer fails
  rather than inventing another identity. Canonical3977test gate predates this change.
- Final typecheck exit0; independent review SHIP with0findings. Partial-writer startup
  rejection is the explicit residual availability limit.


### 2026-09-10 — packaged proposal regression gate

Extended packaged-dashboard-http-probe.mjs with real session/CSRF POST preview,
ready status, exact constraints/completion evidence and digest-shape checks.
Negative retained package GbXulG exits1 at HTTP404!=200; positive retained package
DeVFyt exits0 with6HTTP200responses and proposal_preview=ready. Static bytes remain
identical and successful shutdown exits0. node --check exits0. No product code changed.
Evidence in shared QA: packaged-preview-negative.log and packaged-preview-positive.json.
Both retained artifacts predate current HEAD; this comparison validates the probe's
ability to detect the previously reproduced production composition regression.
It is not a new current-HEAD package, full gate or provider execution verification.


### 2026-09-10 — current isolated package with proposal HTTP gate

- Packaged source ea11197cbce2addb8b379e4180a7e5df16a4db05 into
  /home/jm/.cache/jarvis-test-runtime-qa-20260908/jarvis-runtime-URsHND;
  packager exit0. Source dirty=true retained (git status only untracked node_modules).
  Input digest sha256:b2e55ee7ed5ddf4c443c4c8f78564f55bd1ef10de72aeb7af79c7302a323de65,
 1568input files,1478payload files/9085851bytes.
- Enhanced packaged-dashboard-http-probe exit0: HTML1733bytes, JS451848bytes,
  CSS26606bytes, health1161bytes, session79bytes, preview815bytes; all6responses200.
  Static3files byte-identical; preview ready with exact requirements and digest shape;
  shutdown0. Independent post-probe dependency rehash matched the package receipt.
- Logs/receipts: shared QA package-current-http.log and packaged-current-http.json.
  No browser/provider execution in this HTTP probe; local version capability probes
  remain part of preview. No service configuration or production release changed.
  deployment_ready=false. This package includes the projection-key concurrency fix
  and connecting label, but HTTP checks alone do not re-prove those specific behaviors.

## 패키지 TCP 단절·복구 브라우저 인수 — 2026-09-10

- 대상 URsHND 패키지 source ea11197cbce2addb8b379e4180a7e5df16a4db05,
  input_digest sha256:b2e55ee7ed5ddf4c443c4c8f78564f55bd1ef10de72aeb7af79c7302a323de65.
  개인 임시 DB·루프백 프로세스·Chromium 사용. 운영 서비스 변경 및 provider 실행0회.
- 첫 Playwright setOffline(true) 검증은 15초 후에도 연결됨으로 표시되어 실패했다.
  이 방식이 기존 SSE 소켓을 단절했다는 증거는 없어 제품 결함으로 확정하지 않았다.
- 후속 검증은 로컬 HTTP 프록시의 실제 TCP 소켓을 destroy하고 새 연결을 차단했다.
  브라우저 상태가 다시 연결 중으로 바뀐 뒤 연결을 허용해 연결됨 복귀를 확인했다.
  프록시는 Host/Origin을 upstream 주소로 변환한다. 초기 미변환 실행의 preview403은
  테스트 프록시 설정 오류이며 제품의 origin 검증을 변경하지 않았다.
- 화면 폭1440/1024 각각 복구 후 preview Ready, 1024에서 pending workflow.start
  생성 확인. 양쪽 수평 overflow0, pageerror 및 의도한 단절 구간 밖 console error0.
  단절 구간 console error는 수집 제외하므로 전체 console error0이라는 뜻은 아니다.
  서버 종료 code0/signal null, 최종 probe exit0.
- 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/ 아래
  packaged-dashboard-recovery.log(최초 실패), packaged-dashboard-tcp-recovery-probe.mjs,
  packaged-dashboard-tcp-recovery.log, packaged-dashboard-tcp-recovery.json.
- 범위: 실제 TCP 단절 후 SSE 재연결과 복구 후 사용자 입력 경로. 단절 중 타 클라이언트가
  만든 변경의 정합성, 장시간 단절, 느린 소비자의 메모리 상한은 이 인수에서 검증하지 않았다.
  Backlog17 전체 완료 및 운영 배포 준비 완료를 주장하지 않는다.

## TCP 단절 중 다른 브라우저가 생성한 요청 복구 — 2026-09-10

- 같은 URsHND 패키지의 격리 DB/HTTP 서버에서 Chromium 별도 context2개 사용.
  관찰 브라우저(1440px)의 프록시 TCP 연결을 단절한 동안 직접 연결 브라우저에서
  preview 후 workflow.start 요청1개를 생성했다. 승인/실행/provider 호출은 하지 않았다.
- 직접 조회 overview의 pending request ID와 재연결 후 관찰 브라우저가 받은
  overview의 ID가 일치: request_id-d8bb102b-c7d9-41a1-b07f-50e071980e03.
  양쪽 pending_approvals1개. 관찰 브라우저의 navigation/reload 없이 연결됨으로
  복귀하고 빈 승인 안내가 사라지며 승인 패널 항목이 표시됐다. Probe exit0, 서버 exit0.
- 단절 중 overview는 기존 내용을 유지하지 않고 Unable to load overview / Offline /
  Retry를 표시했다. 초기 snapshot 후속 조회 실패 시점의 현상으로, 단절 중 마지막
  데이터 표시 UX는 잔여 검토 대상이다. 복구된 데이터의 정합성 통과와 구분한다.
- 초기 harness의 빈 화면 유지 가정과 중복 텍스트 locator를 수정했다. 최종 검증은
  서버의 실제 request ID 비교와 승인 패널 record-title 표시를 확인한다.
- 증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/ 아래
  packaged-dashboard-missed-update-probe.mjs, packaged-dashboard-missed-update.log,
  packaged-dashboard-missed-update.json. 장시간 단절/대량 변경/느린 클라이언트
  메모리 상한을 검증한 것은 아니며 Backlog17 잔여를 유지한다.

## 실제 TCP 느린 소비자의 SSE 전송 상한 — 2026-09-10

- URsHND 패키지의 compiled createBoundedSseSink를 실제 Node HTTP ServerResponse에
  연결하고, net.Socket 클라이언트는 HTTP 요청 후 pause하여 응답을 읽지 않았다.
  전체 dashboard 라우트 부하가 아닌 패키지 sink의 실제 소켓 인수다.
- 16,008바이트 프레임 전송 시도5,280,000회, 실제 response.write175회.
  write 직후 측정 writableLength 최대80,244바이트 <= 상한131,072바이트.
  마지막 write(false)부터 종료까지5,000.744961ms, 설정 drain timeout5,000ms.
  대기 중 추가 전송 시도가 기존 타이머를 연장하지 않음을 실제 시간으로 확인했다.
- Probe exit0. 격리 HTTP 서버/클라이언트 종료. 운영 변경/provider 호출0회.
  증거: /home/jm/.cache/jarvis-test-runtime-qa-20260908/ 아래
  sse-real-backpressure-probe.mjs, sse-real-backpressure.json.
- 이 측정은 Node writable buffer 상한이며 RSS/heap/커널 소켓 버퍼의 총 메모리
  상한이 아니다. 전체 dashboard 다중 클라이언트 부하 및 장시간 단절 검증은 잔여다.

## 실제 TCP 역압 검사를 회귀 테스트로 편입 — 2026-09-10

- tests/integration/dashboard-sse-real-backpressure.test.ts 추가. 실제 Node HTTP
  writable과 읽기를 멈춘 TCP 클라이언트를 사용한다. response.write의 반환값 및
  writableLength를 조작하지 않고 관측하여 버퍼 상한·전송 병합·종료 기한을 검사한다.
- 소켓/서버/타이머를 finally에서 정리한다. CI 스케줄링 여유를 포함한 종료 상한
  및 테스트 timeout을 명시했다. 전체 프로세스 메모리 상한 검사는 아니다.
- canonical integration runner로 기존 backpressure7개+실제 TCP1개=2파일8테스트
  통과(exit0), 새 테스트5.367초. 전체 typecheck exit0, 변경 파일 ESLint exit0.
  실행 명령: node scripts/run-tests.mjs integration
  tests/integration/dashboard-sse-real-backpressure.test.ts
  tests/integration/dashboard-sse-backpressure.test.ts.
- 제품 소스 변경0개. 기존 임시 실제 소켓 인수를 저장소 자동 회귀 경로에 포함했다.
  전체 verify 재실행 및 전체 backlog 완료를 의미하지 않는다.

## 종료된 SSE 연결의 자동 복구 수정 — 2026-09-10

- 전체 연결 수 상한을 검토하면서 HTTP503에 대한 선행 복구 결함을 발견했다.
  기존 URsHND 패키지를 Chromium에서 열고 첫 events 요청만503으로 응답했을 때,
  6.5초 후 요청1회/native readyState2(CLOSED)/화면 다시 연결 중이었다.
- store는 CLOSED 오류에만 5초 재시도를 예약한다. CONNECTING은 브라우저의 기존
  재접속을 유지하고 오류 중복 호출은 타이머를 추가하지 않는다. stop에서 취소하며
  교체된 연결의 늦은 open/error/snapshot/reconcile은 source identity로 무시한다.
  새 연결의 snapshot이 기존 canonical refetch 경로를 사용한다.
- 수정 빌드 Chromium 인수: 같은 첫503 조건에서6.5초 후 요청2회/readyState1/연결됨.
  실제 임시 DB·HTTP 서버와 브라우저를 사용하되503은 Playwright route로 주입했다.
  새 배포 패키지 인수가 아닌 a68ab13+미커밋 수정의 built checkout 인수다.
- 관련3파일15테스트, 전체 typecheck, 변경 파일 ESLint, dashboard build exit0.
  증거: 공통 QA 경로의 packaged-dashboard-sse-503-probe.mjs/json 및
  dashboard-sse-503-fixed-probe.mjs/json. 서비스 종료code0. 제품의 승인/실행 경로 변경0개.
- readyState를 제공하지 않는 사용자 정의 EventSourceLike는 기존 동작을 유지한다.
  영구 장애도 화면이 열린 동안5초 간격으로 조회 연결을 재시도한다. 전체 연결 수
  상한은 아직 구현하지 않았으며 이 수정을 해당 항목 완료로 집계하지 않는다.
- 후속 전체 dashboard 검사:38파일263테스트/34.67초, exit0. 부모가 변경 diff와
  연결 교체·타이머 취소·늦은 이벤트 검증을 확인했다. 별도 에이전트 리뷰는 수행하지 않았다.

## SSE 구독 수 상한과 포화 후 브라우저 복구 — 2026-09-10

- Hub당128개 구독 상한, 초과 HTTP503/SSE_CAPACITY_EXCEEDED/Retry-After5 구현.
  direct hub도 같은 상한을 적용한다. 기존 연결의 이벤트 전달은 계속되며 종료 시
  슬롯이 반환된다. 상세 결정·검증: planning/adr-sse-connection-capacity.md.
- 관련3파일12테스트, typecheck, backend build, 변경 파일 lint exit0.
  실제 built dashboard의128개 SSE 포화→브라우저503→1개 해제→브라우저 두 번째
  요청 성공/연결됨을 확인했다. 서버 종료code0. 운영 서비스 변경0개.
- 전체 HTTP 소켓/RSS/장시간 과부하의 상한을 확인한 것은 아니다. Backlog17의
  연결 수 무제한 경로를 보완했으며 전체01–25 목표는 계속 유지한다.

## 503 재접속 브라우저 회귀 및 전체 E2E — 2026-09-10

- e2e/sse-recovery.spec.ts 추가, scripts/run-tests.mjs의 기본 E2E 목록에 포함.
  첫 events 응답만503으로 주입하고 두 번째 요청의 실제 SSE 연결과 canonical
  overview 재조회를 확인한다. 새로고침/변경 요청0개, 예상 events503 외 오류0개.
- 집중 검증1440/1024의2개 통과(26.3초). E2E 타입 검사, 새 파일 ESLint,
  runner node --check exit0. 이후 전체 node scripts/run-tests.mjs e2e는
  1440/1024 총30개 통과(1.5분), exit0. 로그: 공통 QA의 sse-recovery-e2e.log.
- 제품 소스 변경0개로 앞선2807414 전체 verify의 빌드를 사용했다. 새 테스트와
  runner 목록 변경은3985테스트 gate 이후이며 해당 gate에 소급해 포함하지 않는다.
  실제 서버 용량 포화 후 복구 인수는 앞선 별도 기록을 따른다.

## SSE 후속을 포함한 최신 패키지 인수 — 2026-09-10

- package-authority-runtime exit0, 출력 공통 QA의 jarvis-runtime-NxuC5J.
  source dc4c05a8f733751bcad65aa229a78616b7914846, source_dirty=true
  (git status는 미추적 node_modules1개), input1571파일, payload1480파일/9093244바이트.
  input_digest sha256:03d5ec1c0631a6f19aa62826c0e0bab3959ec82a6f4acad349a421fe7a19da3d.
- 패키지 CLI smoke 및 identity 검사를 포함한 생성 완료 후 독립 프로세스로
  runtimeDependencyIdentity 재계산 일치를 확인했다(exit0).
- packaged-dashboard-http-probe exit0: HTML/JS/CSS 바이트 일치, health/session/
  제안 preview 포함6응답200, preview ready, 서버 종료code0/signal null.
- 패키지의 실제 서버와 Chromium: SSE128개 유지→브라우저503→연결1개 해제→
  브라우저 두 번째 요청200/readyState1/연결됨. route 응답 모킹 없음, exit0.
- 증거: 공통 QA의 package-sse-capacity.log, packaged-sse-capacity-http.json,
  packaged-sse-capacity-browser-probe.mjs, packaged-sse-capacity-browser.json,
  패키지 runtime-package-receipt.json. 이전 URsHND 인수와 소스를 구분한다.
- deployment_ready=false 유지. provider 계약·sealed manifest·실제 운영 활성화
  게이트는 이 개발 패키지 검사로 충족되지 않는다. 서비스 변경/배포0회.

## 최신 자비스 패키지와 설치된 Second Brain 연동 — 2026-09-10

- 자비스 NxuC5J(source dc4c05a), provider 설치물
  /var/tmp/sb-inbox-release-gicqbwxw/releases/78a5792d53a7cbdb1b4d4c50f58ca63cd97c77f1
  (provider source f0fec140aee0fbe14fcd9289e7461509144a6c7e)을 연결했다.
  provider 작업공간 현재 HEAD0947571은 문서 커밋이며 설치 source와 구분한다.
- provider deploy/check-release-integration.py의 원본 실행은 dist/node_modules/undici
  경로가 없어 중단됐다. 패키지에는 개발용 undici가 없으며 SDK는 root/node_modules에
  있다. 패키지 변경 대신 임시 harness2파일의 import3개만 조정했다: HTTP 시험 도구는
  기존 개발 설치 undici, MCP SDK2개는 패키지 자체 root/node_modules. 첫 조정 후
  SDK 경로 실패도 확인했으며 최종 조정 실행만 exit0이다.
- 승인된 MCP 쓰기→실제 TLS/gateway/CLI/provider→proved→JARVIS settled/control
  completed→새 로그인 조회 통과. settlement1/attempt1, 같은 generation 확인.
  독립 stdio reader2개가 각각 기록2개 회수, reader 철회 후403.
  접수 중 철회는 accepted row0; 실행 전 철회·만료는 failed/active generation false.
  4개 시나리오 모두 FK 오류0. 합성 identity/source/policy/clock, native 모델 호출0회.
- 검증 전후 provider18474항목, JARVIS8178항목 및 Node 실행 파일 일치.
  provider inventory babb369eec8daf16f72659b34ad4a300c18875bc7ec34a0b3c163dfd5247fb2e,
  JARVIS inventory 9b720c4dd046b004c3af3d1436130493a8538cc10b241d3f4d792f656e2db1ec.
- 증거: 공통 QA의 run-packaged-provider-pair.py,
  latest-packaged-provider-pair-adapted.json/stderr, 원본 실패 latest-packaged-provider-pair.stderr.
  성공 JSON은 원본/수정 harness SHA와 import 경로를 포함한다. 원본 harness 무수정
  통과나 두 패키지만으로 모든 시험 의존성이 충족된다고 주장하지 않는다.
- provider 소스/운영 current/서비스/운영 DB 변경0개. production_activated=false.
  이 인수는 일일 refresh publication 계약이나 원본 업무 계보의 자동 기억 수집
  계약을 충족하지 않으므로 해당 HOLD와 전체01–25 잔여는 유지한다.

## 보관된 실행 패키지의 독립 무결성 검사 명령 — 2026-09-10

- scripts/verify-runtime-package.mjs 추가. 사전에 기록한 receipt SHA256을 필수로
  받아 payload/의존성 전체 벡터와 backend 메타데이터를 다시 대조한다. 검사 코드는
  신뢰하는 개발 checkout에서 로드하며 대상 패키지 코드를 import/실행하지 않는다.
- packager와 verifier의 필수 루트 목록을 scripts/lib/runtime-package-roots.mjs로
  공유했다. 기존 목록은 동일하다. payload 하위 node_modules/.git는 명시적으로
  거절해 기존 파일 열거기의 제외 규칙으로 숨는 입력을 허용하지 않는다.
- 실제 NxuC5J와 별도 복사본으로7개 CLI 시나리오 검증: 원본/복원본/원본 재검사
  exit0, 잘못된 receipt pin/변경 payload/추가 dependency/중첩 dependency는 각각
  해당 오류 코드와 exit1. 복사본은 finally 정리. JS3파일 node --check와 diff check0.
  결과: 공통 QA의 runtime-package-integrity-results.json.
- 해시 일치는 서명·출처 증명·실행 시험·배포 권한이 아니다. 검사 도중 파일 교체를
  잠그지 않으며, payload/의존성 범위 밖 로그 등은 검사 대상이 아니다. 결과에
  signature_verified=false/runtime_validation=not_performed/deployment_ready=false 명시.
  제품 backend/frontend 소스 변경0개, 기존 전체 verify3985/E2E30과 구분한다.

## 패키지 무결성 검사 사전 순회 상한 — 2026-09-10

- verify-runtime-package의 배열 기반 사전 순회를 opendir/readSync로 바꾸고,
  payload32768항목/의존성65536항목, 깊이64, 각 범위256MiB 파일·링크 크기 상한을
  적용했다. 한도를 넘으면 내용 해시 전에 PACKAGE_TREE_LIMIT으로 거절한다.
  특수 파일도 거절하며 열었던 directory handle은 finally에서 닫는다.
- 원본 NxuC5J와 별도 복사본의 실제 CLI6시나리오 확인: 원본/원본 재확인 exit0;
  깊이65/항목32769개 추가/256MiB 초과 희소 의존성 파일은 limit/exit1;
  필수 cli-smoke 파일 누락은 verification failed/exit1. 복사본은 정리했다.
  결과: 공통 QA의 runtime-package-bounds-results.json. node --check/diff check0.
- 안정된 파일 트리에서 검사 자원을 제한하는 사전 검사다. 사전 검사 후 파일을
  교체하는 동시 변경, 프로세스 전체 RSS 상한, 서명 검증을 보장하지 않는다.

## 패키지 무결성 CLI 자동 회귀 편입 — 2026-09-10

- tests/integration/runtime-package-integrity-cli.test.ts 추가. 각 테스트는 별도
  임시 candidate/고정 receipt를 만들고 실제 Node CLI 자식 프로세스를 실행한다.
  candidate의 검사 모듈은 실행 시 throw하도록 만들어 후보 코드 비실행을 확인한다.
- 정상 무결성/잘못된 pin/payload 변경/의존성 추가/중첩 의존성/필수 파일 누락
  6개 통과(1파일,0.441초). backend tsc --noEmit 및 새 파일 ESLint exit0.
  각 fixture는 finally에서 정리하고 자식 종료 코드·signal·구조화 결과를 검증한다.
- 기존 실물 NxuC5J 변형 인수와 별도로 일반 integration/backend discovery에
  포함되는 회귀 검사다. 전체3985 gate 이후 테스트 추가이며 소급 집계하지 않는다.
