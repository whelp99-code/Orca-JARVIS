# Dashboard overview 조회 중복 제거

- 날짜: 2026-09-08
- 범위: P2-16, 기존 overview 응답과 현재 원본 차단을 유지하는 조회 최적화
- 상태: 구현 및 격리 실제 HTTP/Chromium 검증 완료. 운영 배포와 전체 개선 목표는 미완료.

## 문제와 변경

overview는 doctor의 위험 정보와 생성 시각을 얻기 위해 CURRENT_STATE 전체를 만들면서
500개 task projection을 계산하고, 화면의 20개 미리보기와 전체 활성 수를 다시 계산했다.
doctor의 기존 검사와 비동기 provider 관측을 유지하면서 필요한 위험 정보만 직접 매핑한다.
비동기 관측 이후 task·approval·agent·portfolio의 동기 조회는 하나의 deferred transaction에서
읽는다. 동기 조회 중 쓰기를 감지하면 transaction 내부에서 실패하여 그 쓰기도 rollback한다.
portfolio와 second_brain의 별도 redaction 깊이는 기존과 같다.

TaskTimelinePopulation.overview는 기존 canonical ID·alias·상태 우선순위·현재 차단 CTE를
재사용하여 전체 활성 수와 최근 목록을 한 statement로 반환한다. 최근 scalar 행을 정렬·LIMIT한
MATERIALIZED CTE 밖에서 source_ids를 집계한다. 추천 전체의 identity/event 검증과
정본 exclusion 규칙은 유지한다. authority cache나 새 저장소는 추가하지 않는다.

## 폐기한 초안

처음에는 source_ids 상관 집계가 포함된 SELECT를 recent CTE 내부에 넣었다. 기능 검사를
통과했으나 실제 1만 건에서 overview가 약 0.7초에서 6.9~7.2초로 악화됐다.
실행을 중단하고 EXPLAIN으로 LIMIT 전 후보별 상관 집계를 확인했다. bounded recent를 먼저
확정한 뒤 source_ids를 조회하도록 수정하고 기능·성능 검사를 다시 실행했다.
실패 로그와 query plan을 보존하며 최초 초안을 성능 개선으로 취급하지 않는다.

## 실측

증거 디렉터리: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.
`overview-projection-live.mjs/json/log`은 90% completed/10% pending 명령과 1024자 args padding의
격리 SQLite를 사용한다. 이전 비교본은 ff897bb의 read-model/state/recommendation/population
컴파일 사본이며 다른 의존성은 공유한다. 이전 전체 checkout 비교는 아니다.
이전 5표본, 이후 10표본, 이후 실제 HTTP 5표본이다.

| 명령 수 | 이전 overview p95 | 이후 overview p95 | 이후 HTTP p95 | prepare 호출 이전→이후 | 응답 bytes |
|---|---:|---:|---:|---:|---:|
| 10,000 | 774.761ms | 164.486ms | 148.131ms | 6,137→104 | 10,288 |
| 100,000 | 7,400.408ms | 1,338.501ms | 1,251.268ms | 60,137→104 | 10,304 |

두 규모에서 이전/이후 전체 payload deep equality, 원본 quarantine 이후 equality,
GET DB 쓰기 0건을 확인했다. population statement는 6→2회다. prepare 호출 수는
SQLite 내부 반복 실행 수가 아니며, 전역 count와 population 작업은 데이터 규모에 비례한다.

실제 built Chromium의 10만 건 최초 화면은 10,871ms였다. 전체 활성/승인 카드 9,999,
미리보기 20개를 표시하고 추가 원본 차단 후 두 카드가 9,998로 갱신됐다.
pageErrors 0건, 임시 DB/서버/브라우저 제거를 확인했다. 이 화면 지연은 아직 개선 대상이다.
500개 task 목록과 초기 재조회 비용을 별도로 측정해야 하며 원인 확정으로 취급하지 않는다.

## 검증과 남은 범위

- 관련 backend 10개 고유 파일 49개 검사 통과(7파일30개 및 겹치는 3개를 포함한 4파일22개).
- 최종 SQL 수정 후 count·snapshot·추천 identity/event·privacy 4파일20개, reviewability 2개 통과.
- build/typecheck/lint 통과. 마지막 SQL 수정 후 backend build와 lint를 재통과했다.
- 독립 정적 리뷰 필수 결함 0건. 성능 회귀 발견은 위 실제 probe의 별도 증거다.
- 로그: `overview-projection-{tests,final-tests,bounded-tests,reviewability,types,lint-final,bounded-build}.log`.
- 실패 증거: `overview-projection-combined-regression.log`, `overview-query-plans.json`,
  `overview-query-bounded-candidate.json`, `overview-projection-stopped.json`.

최신 전체 verify 완료 SHA는 704f238이다. 이후 단위 검증을 새 전체 gate 완료로 확대하지 않는다.
전체 목록/페이지 범위와 UI 지연, 전체01–25 인수, 운영 검증은 남는다. 자동 기억 수집의
원본 차단 전파 HOLD와 memory-store 큐 보류를 유지한다. 운영 DB/서비스/release/push 변경은 없다.
