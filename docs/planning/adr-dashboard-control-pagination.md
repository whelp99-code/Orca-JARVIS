# 승인 목록의 SQL 조회와 페이지 처리

2026-09-08. P2-16 중 승인 목록·전체 pending 수·대시보드 표시 범위.

## 문제와 결정

기존 DashboardReadModel은 ControlPlane.list()로 모든 명령의 target/args를 읽고
행별 projection readiness·quarantine·suppression을 조회한 후 상태를 걸렀다.
overview도 이 목록을 다시 가져왔다. 승인 표시에는 대부분의 실행 본문이 필요하지 않다.

- control-request-read.ts에서 pending/approved/failed 상태와 정확한
  control_payload/request_id/request_id 차단 조건을 SQL에 함께 적용한다.
  projection authority가 ready인지 먼저 검사하며 GET에서 초기화·쓰기를 하지 않는다.
- 화면용 메타데이터와 task.execute의 문자열 task_id만 읽는다. failed workflow.start는
  기존 retry 정책의 전체 입력 검증에 필요한 args를 읽고 동일 정책 함수를 사용한다.
- migration069는 actionable 상태의 requested_at/request_id 부분 인덱스를 추가한다.
  기존 migration bytes는 보존한다. 첫 페이지는 인덱스 순회, 후속은 tuple seek다.
- GET /api/v1/control/requests?limit=50은 최대100건을 허용하고 page의 total/returned/
  has_more/next_cursor를 반환한다. 쿼리 없는 기존 v1은 전체 actionable 목록과
  기존 localeCompare 순서를 유지한다. 이 호환 경로는 여전히 결과 크기에 비례한다.
- 새 페이지 순서는 SQLite BINARY requested_at/request_id 오름차순이다. cursor는
  rowid 문자열과 정렬 키·명령 digest의 SHA-256으로 구성된 작은 탐색 위치다.
  원래 요청 ID가4096bytes여도 cursor는200자 미만이다. 길이·구조를 검사하고 값을
  SQL parameter로만 사용한다. cursor는 승인·실행 권한이나 불변 snapshot이 아니다.
- 후속 조회는 anchor를 찾아 digest를 확인한 뒤 원래 정렬 키로 seek한다. 원본 차단이나
  상태 변경은 즉시 반영한다. anchor 물리 부재/교체/이동은409 CONTROL_PAGE_STALE로
  반환하고 첫 페이지로 복구한다. 페이지마다 같은 read transaction에서 전체 수를 계산한다.
- overview는 pending 전체 수와 첫20개 미리보기를 분리한다. React 카드도 전체 수를
  사용하며 전체 승인 목록 링크를 제공한다. 브라우저 목록은50건씩 한 페이지만 보관하고
  다음/처음 이동, 현재 페이지 새로고침, 빈 마지막 페이지와 오류의 첫 페이지 복구를 지원한다.
  요청 시 version을 올려 늦은 이전 페이지의 성공/실패가 현재 선택을 덮어쓰지 못하게 한다.

## 실제 측정

격리 합성 DB의90% completed/10% pending, args별1024자 padding. 이전 전체 조회
재현은5회, 새 페이지·pending summary·실제 HTTP는각20회다. 아래 p95는 이 표본의
관측값이며 일반 운영 SLO나 같은 크기 전체 목록을 반환하는 속도 비교가 아니다.

| 전체 명령 | 이전 전체 조회 p95 | 새50건 조회 p95 | 실제 HTTP p95 | 이전/새 반환 bytes |
|---|---:|---:|---:|---:|
| 10,000 | 246.421ms | 0.487ms | 3.218ms | 227,030 / 11,559 |
| 100,000 | 2,877.637ms | 2.489ms | 4.840ms | 2,270,030 / 11,560 |

JavaScript에서 계측한 SQL prepare 호출은30,002/300,002회에서 두 규모 모두5회였다.
이는 상관 subquery 내부 탐색이나 transaction 제어까지 센 SQLite VM 실행 횟수가 아니다.
정확한 COUNT는 actionable 개수에 비례하므로 SQL 작업 전체가 상수 시간이라는 뜻도 아니다.
pending summary p95는0.285/1.663ms, prepare3회, 반환20개다.

각 규모의 대상1,000/10,000개를100개 페이지로 끝까지 순회해 중복0·누락0을 확인했다.
EXPLAIN에서 부분 인덱스와 후속 tuple seek를 확인했고 ORDER BY 임시 B-tree는0개다.
cursor 발행 뒤 다음 페이지의 원본을 차단하면 즉시 제외되고 total도 감소한다. GET쓰기0.
실제 built Chromium은105건을50→50→5개로 이동한 뒤 첫 페이지로 돌아왔고,
overview 카드105/미리보기20을 표시했다. pageErrors0. 임시 DB·서버·브라우저 제거.

## 검증과 남은 범위

dashboard32파일187개 pass; 최종 mock 타입 정리 후4개 재통과. 관련 backend5파일은
원본 차단·준비 상태·retry deadline·HTTP 읽기 회귀와 페이지4개를 포함해26개 통과했다
(최종 페이지 fixture 수정 전25pass/1실패, 수정 후 해당4개 재통과).
추가 task execution·migration·가독성 gate에서32pass/기존 길이 초과1개를 확인했고,
문자열170bytes를 보존한 별도7fe1251 수정 후 migration·가독성9개를 통과했다.
typecheck/build/lint exit0, 독립 리뷰의 긴 ID 지적 수정 후 필수 결함0이다.

최초 규모 probe는 두 번째 DB 교체 뒤 이전 read model을 사용해 실패했다. DB별로
read model을 구성하여 최종 exit0을 확인했다. 제품 실패나 첫 측정 삭제로 처리하지 않는다.
증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의
control-page-live.mjs/json/log, control-page-live-closed-fixture.log,
control-page-overview-browser.png 및 control-page-*.log.

이 단위는 승인 조회를 개선한다. 전체 overview의 state projection/timeline 비용,
다른 목록의 pagination·범위와 전체01–25/운영 인수는 남는다. 기존 자동 기억 수집의
원본→파생 차단 HOLD와 memory-store 큐 적용 보류를 유지한다. 운영 배포·DB 변경0.
