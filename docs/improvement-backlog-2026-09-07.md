# Orca-JARVIS 수정·개선·고도화 분석 — 2026-09-07

분석 대상은 현재 로컬 작업 트리와 운영 DB의 읽기 전용 조회다. 아래 우선순위와 설계안은
확인된 코드/재현 결과에 근거한 제안이며, 제안 기능이 구현됐다는 뜻이 아니다.
이번 분석에서는 제품 코드와 운영 서비스를 변경하지 않았다.

## 기준 상태

- branch `main`, 로컬 추적 origin/main 대비 ahead/behind 0/0 (이전 작업 실측).
- src: 430파일 / 52,716행, 50행 미만 81파일.
- dashboard/src: 74파일 / 8,901행 (동거 테스트 포함).
- tests: TypeScript 계열 368파일 / 36,354행. 테스트 실행 파일 수와 다른 집계다.
- 운영 DB: migrations 58개, 사용자 테이블 213개.
- 운영 service/dashboard: active/running.
- 운영 GJC 설정, 관찰 바인딩, work_items, GJC intents, workflow runs, control requests,
  daily-loop runs, notification intents, memory outbox, recommendation-work runtimes: 각각 0행.
- 이전 전체 backend 실행: 1,815 pass / 2 fail. 실패 조치 후 관련 12개 재검증 pass.
  최종 dashboard 136 pass, lint/typecheck/build/acceptance/CLI smoke exit 0.
  최종 수정 후 전체 backend를 다시 실행한 것은 아니다.

P0: 실제 업무 연결 전에 해결할 항목. P1: 실행·운영 기능의 완결성.
P2: 유지보수·성능·검증 비용. P3: 기본 실행 경로가 검증된 뒤의 확장.

## 격리 재현 결과

운영 변경 없이 메모리 SQLite와 가짜 GJC runner로 확인했다.

1. 동일 owner `gjc-runtime`의 유효 runtime lease 재획득: fence 1 → 2.
   다른 owner의 획득은 null. CLI가 고정 owner를 사용한다.
2. intent lease 1초로 claim 후 120초 시점 settle: completed 저장 허용.
   recoverExpiredGjcIntents가 먼저 호출되지 않은 경로다.
3. 가짜 password 표식을 포함한 GJC stderr: 던져진 error.message에 원문 표식 잔존.
4. supervisor 콜백 실패: service.once 오류 전파, coordinator 호출 0회.
5. 동일 목표·작업 유형에서 제약과 완료 증거 변경: 두 proposal 모두 ready,
   proposal_digest 동일.

## 수정 — 기존 동작의 결함과 오해 제거

| ID | 우선순위 | 확인 사항·근거 | 제안 변경과 완료 기준 |
|---|---|---|---|
| 01 | P0 | `src/gjc.ts:11`: redact가 `$&` 문자열 자체를 먼저 치환해서 실제 매치 원문을 반환한다. 가짜 비밀번호 원문 잔존 재현. | 캡처 그룹/콜백으로 값 제거, 공유 비밀정보 필터 적용. token/password/Authorization 및 다중행 오류에서 비밀 표식 0개. |
| 02 | P0 | `src/cli-gjc-commands.ts:28` 고정 owner; `src/gjc-configuration-store.ts:81` 동일 owner는 유효 lease도 재획득. fence 1→2 재현. | 프로세스/기동별 owner와 명시적 갱신 분리. 동일 DB에 두 실제 프로세스를 실행해 coordinator 동시 소유자 최대 1개. |
| 03 | P0 | `src/gjc-intent-store.ts:114`: settle은 state/fence만 확인하고 lease expiry를 확인하지 않음. 만료 119초 후 저장 재현. | 정산 시 현재 시간·lease·필요한 상위 권한을 재검증. 만료/이전 fence의 성공 정산 0개. |
| 04 | P0 | `src/team-proposal.ts:233`: proposal hash에 objective/members만 포함. `src/dashboard/command-service.ts`도 constraints/completion_evidence를 workflow input에 보존하지 않음. | 정규화 TaskSpec에 범위·금지 작업·완료 기준·예산을 보존하고 승인/디스패치/검증까지 같은 digest를 전달. 제약 한 필드 변경 시 digest 변경. |
| 05 | P1 | `src/dashboard/read-model.ts:224`: 등록 binding을 항상 live로 반환. | 실제 구조화 관측 시각·연결·incarnation으로 live/stale/offline/unknown 결정. 등록만 된 대상이 live로 표시되지 않음. |
| 06 | P1 | `src/dashboard/read-model.ts:70,84`: 최근 20개로 전체 activeWork 카드를 계산. | 전체 활성 수와 최근 목록 분리. 활성 21건·최근 20건 시 카드 21, 목록 20. |
| 07 | P1 | `src/personal-os-retention.ts:92,107`: adapter 미등록이면 EMPTY counts 후 completed. | 미설정/지원 안 됨/처리할 데이터 없음 구분. adapter 없는 작업은 completed 불가; 실제 보존 정책과 cutoff 전달 검증. |
| 08 | P1 | `src/memory-projection-lineage.ts:27,133`: 생성자에서 rebuild 및 UPDATE 수행. 읽기 모델은 total_changes 불변을 기대. | 초기화/복구를 startup 또는 명시적 관리 경로로 옮기고 읽기 경로는 준비 상태 검사. pending 상태의 첫 GET에서도 암묵적 쓰기 0개. |
| 09 | P1 | `src/dashboard/authority-service.ts` retryCommand는 args를 복사하고 요청 expiry만 새로 계산. 기존 workflow budget.deadline은 유지. | 원본 권한을 묵시적으로 확장하지 말고 만료된 작업의 재계획·재승인을 안내. 유효하지 않은 재시도 버튼/반복 실패 제거. |

## 개선 — 기존 기능을 실제 운영과 연결

| ID | 우선순위 | 확인 사항·근거 | 제안 변경과 완료 기준 |
|---|---|---|---|
| 10 | P0 | 운영 service는 running이나 GJC 설정·관찰 대상 0행. `service status`의 readiness는 이전 수정에서 추가. | 실행 환경/세션/대상 등록과 권한·프로토콜 실증 절차 마련. UI에서 프로세스 생존과 업무 준비 상태를 따로 표시. |
| 11 | P0 | `src/approved-executor.ts:102`: workflow.start는 graph.start 후 workflow.started 반환. 일반 dashboard task→GJC 전달 연결 없음. | TaskSpec→승인→durable dispatch→실행 증거→검증→최종 결과의 한 경로 연결. 허용된 파일 변경 1건을 입력부터 결과까지 추적하는 인수 검증. |
| 12 | P1 | `DailyControlLoop`는 src에서 정의와 export만 확인. `PersonalOsRuntime.forServiceRun`은 GJC service 생성; retention 객체 생성도 자동 실행은 아님. | 아침·저녁·retention 스케줄과 실제 어댑터를 서비스에 연결. 재시작/누락 시간/중복 기동에서도 하루 단계별 실행이 멱등적으로 기록. |
| 13 | P1 | `src/service.ts`는 supervisor를 먼저 await. 가짜 supervisor 오류에서 coordinator 호출 0회. | 관찰 실패와 실행 큐의 장애 영역 분리. 안전·권한 오류는 차단하고 일시적 조회 실패에는 제한된 재시도/회로 차단 적용. 별도 상태·원인 기록. |
| 14 | P2 | 430파일 중 81개가 50행 미만; `tests/integration/task12-runtime-reviewability.test.ts`가 250행/160자 강제. | 먼저 규칙과 도메인 경계를 ADR로 정하고 authority/execution/observation/memory/daily/transport 별로 정리. 의미 없는 재분할·문장 압축 대신 순환 의존/변경 영향/복잡도 검증. |
| 15 | P2 | `package.json`에서 backend/dashboard/Electron 설치·빌드·검증 결합. postinstall은 install-electron. | 서버·대시보드·desktop build/install 경로 분리, 공유 계약 명시. 서버 검증에 Electron 다운로드/화면 초기화가 필수이지 않도록 구성. |
| 16 | P2 | overview가 상태 투영·timeline·전체 control 목록을 읽음. listControlRequests도 전체 목록 후 filter/sort. 이전 단건 개선은 4개 경로에 한정. | 필요한 상태/컬럼/범위만 SQL 조회하고 keyset pagination·인덱스 적용. 1만/10만행에서 쿼리 수·p95·반환 바이트 측정. 권한 판단은 오래된 캐시 사용 금지. |
| 17 | P2 | SSE sink는 response.write의 false 반환을 무시; DB 변경 관찰은 1초 주기. | 느린 연결의 버퍼 상한·종료/재접속 정책, 이벤트 병합과 토픽별 갱신 적용. 느린 클라이언트에서 메모리 상한과 재연결 정합성 검증. |
| 18 | P2 | 전체 backend 762.49초; /tmp quota·Xvfb 환경 실패 실측; 원문 분석 테스트는 과거 commit/문자열에 결합. | 빠른 단위/계약/실프로세스/GUI 검증 분리, 임시 경로·화면 사전 점검, 생성물 정리, 관련 테스트 기본 제외 설정 중앙화. 같은 실행 방법으로 재현 가능한 결과. |
| 19 | P1 | 위키는 57 migrations, 현재 운영은 58. AGENTS의 규모·과거 운영 설명도 현 구조와 차이. authority/control-center는 별도 release roots. | 소스 SHA·artifact digest·schema vector·운영 적용 여부를 상태 화면에 연결. 자동 인벤토리와 현재 운영 문서 정본 유지. 과거 migration bytes는 보존. |

## 고도화 — 업무 범위를 넓히는 기능

| ID | 우선순위 | 현재 근거 | 제안 변경과 완료 기준 |
|---|---|---|---|
| 20 | P1 | `../dev-wiki/routing.md`는 초안/코드 미반영. 문서의 첫 일치 규칙과 더 구체적 문서 우선 예외도 정리가 필요. | 버전이 있는 routing config와 설명 가능한 분류 도입. 충돌/미분류/낮은 확신은 검토 상태로 두고 메일·코드·기술·견적 사례별 일치 테스트. |
| 21 | P1 | recommendation dispatch provider는 codex/claude, 외부 업무 실행자 레지스트리 없음. capability runtime probe는 실행 가능성을 확정하지 않음. | 어댑터별 scope·input/result schema·readiness·timeout·idempotency·권한 요구 등록. 미설치·인증 안 됨·미권한·준비됨 구분. 실제 연결된 실행자만 선택. |
| 22 | P1 | Second Brain 쓰기/outbox 코드는 존재; 현재 운영 memory_outbox 0행. 코드 작업 결과의 dev-wiki 후처리 연결도 목표 단계. | 검증된 결과에서 업무 기억과 개발 결정 초안을 생성. 승인·원본 증거·provider receipt를 연결하고 확정 전 성공 표시 금지. 같은 결과 중복 기록 0개. |
| 23 | P2 | calendar/mail/messenger configured=false. notification/daily loop 원장은 이번 관측에서 0행. | 우선 한 커넥터부터 실제 입력 연결. 이벤트 기반 후속 조치·마감 알림·아침/마감 보고를 운영하고 변화 없는 재알림을 억제. |
| 24 | P2 | `LoopGraph`·runbook·recommendation workflow가 있으나 일반 업무 인수 경로가 연결되지 않음. | 코드 수정, 장애 진단, 기술 검토, 견적 초안 등 3~5개 작업 템플릿을 기존 엔진 위에 구성. 입력·허용 범위·완료 증거·중단 조건이 있는 실행 가능한 템플릿. |
| 25 | P3 | 개인 OS 평가·SLO·진화 모듈은 존재하나 이번 운영 조회의 실제 업무 실행 데이터가 비어 있음. | 업무 성공률, 승인 대기, 재작업, 중복 전송, p95, 비용/성공 작업을 측정. 실제 결과 기반 shadow 비교 후 라우팅/예산을 개선하며 미검증 정책 자동 승격 금지. |

## 실행 순서 제안

1. 01–04: 비밀정보 처리·동시 실행·만료 권한·작업 계약 수정.
2. 10–11 + 최소 21: 준비 상태 확인 후 실행자 한 개로 실제 작업 한 건을 완결.
3. 05–09·12–13: 상태 정확성·복구·일일 운영 연결.
4. 14–19: 실행 경로를 보존하며 구조·설치·조회·검증·문서 비용 축소.
5. 20–25: 라우팅·외부 업무·기억·선제 대응·성과 기반 개선 확대.

파일 수·테이블 수만으로 삭제 대상을 정하지 않는다. 사용 경로와 계약을 확인해 격리/통합하고,
승인 영수증·fence·멱등성·증거 검증 및 기존 migration 이력은 유지한다.
