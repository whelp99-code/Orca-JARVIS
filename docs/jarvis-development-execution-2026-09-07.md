# 자비스 개발 실행 기록

사용자 확정: 기존 개선 목록을 완성 목표로 진행하고, 완료 단위마다 커밋한다.
실사용 검증과 코드/자동 테스트 검증을 구분한다. 문제가 될 기능은 근거와 재개 조건을 남겨 보류한다.
기준 목록은 `improvement-backlog-2026-09-07.md`의 01–25이며 일부 완료를 전체 완료로 보고하지 않는다.

## 실행 범위

| 목록 ID | 작업 | 상태 / 완료 증거 |
|---|---|---|
| 선행 수정 | 만료 intent 복구, 단건 명령 조회, 준비 상태 표시, 중복 build 제거 | 독립 리뷰 신규 결함 0; 관련 3파일 9테스트 pass; lint/typecheck/build exit 0 |
| 01 | GJC 오류의 비밀정보 제거 | 구현·독립 리뷰 완료; 자동 32개 및 실제 자식 프로세스 3개 검증 통과; 실제 coordinator 인수는 후속 |
| 02 | runtime 소유권 | 구현·독립 리뷰 완료; 관련 자동 41개와 실제 프로세스/CLI 2개 시나리오 통과 |
| 03 | 만료 정산 | 구현·독립 정적 리뷰 완료; 만료/rollback 10개 및 기존 관련 25개 통과 |
| 04 | 작업 제약·완료 기준을 승인부터 결과까지 보존 | 제안→승인→workflow 저장 구현; 실제 dispatch·검증 연결은 10–11과 함께 후속 |
| 05–06, 08–09 | 상태·집계·읽기 부작용·재시도 | 대기 |
| 07 | retention 결과 정합성 | 어댑터 미설정 실패, policy 전달, 원자적 처리 구현; 실제 정책별 어댑터·스케줄은 12 후속 |
| 10–11, 21 최소 | 실제 준비 상태와 승인된 작업 한 건의 실행 완결 | 대기; 실사용 인수 필수 |
| 12–13 | 스케줄·관찰 장애와 실행 장애 분리 | 대기 |
| 14–19 | 구조·설치·조회·SSE·테스트·운영 정보 | 대기; 의미 있는 도메인 단위로 변경 |
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
