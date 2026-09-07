# 작업 실행 화면과 기존 승인 실행의 연결

2026-09-08. 범위: 개선 목록 04/11. 자비스 내부 HTTP/화면 연결이며 기억 정본이나 리포 간 역할은 바꾸지 않는다.

## 문제와 결정

작업 상세에는 취소만 있고 실행 계획은 CLI 입력으로만 준비할 수 있다. 사용자가 저장소·파일·검사·새 결과 브랜치를 선택하면 서버가 Git 기준 커밋과 파일 해시를 계산하여 v2 계획을 반환한다. 사용자가 해시를 수작업으로 만드는 흐름을 제품에 추가하지 않는다.

- 준비는 승인된 workflow.start 및 정확한 기본 graph에 연결한다. URL task ID와 run/spec를 검증한 후에만 명시적으로 선택한 파일을 읽는다.
- 기존 결과 게시 계약은 선택한 입력이 기준 커밋과 같아야 한다. 따라서 해시는 Git blob에서 계산하고 작업 파일을 기존 descriptor 기반 검사로 대조한다. 커밋되지 않은 선택 파일은 준비 단계에서 거부한다. 새 파일은 Git과 작업 디렉터리 모두에 없어야 한다.
- Git 조회는 기존 고정 실행 파일·명시적 환경·읽기 전용 sandbox 경계를 재사용한다. 메타데이터 위치 탐색은 고정 Git의 제한된 rev-parse로 수행하고, blob/tree/ref 조회는 읽기 전용 sandbox에서 수행한다. 허용하는 읽기 명령만 추가한다. 입력당 4 MiB, 합계 16 MiB 및 준비 시간 제한을 적용한다. 파일 원문은 응답에 넣지 않는다.
- 미리보기는 DB를 쓰거나 모델을 호출하거나 승인을 소비하지 않는다. 검토한 동일 계획으로 별도의 pending task.execute 요청을 생성한다. staging 시 기준/파일/현재 workflow를 다시 확인한다. 실행은 기존 서명 승인과 ApprovedCommandExecutor를 사용한다.
- 준비 요청은 기존 정확한 Origin·CSRF·64 KiB strict JSON 경계를 거친다. 결과 조회는 로컬 CSRF를 요구하고 no-store로 제공한다. task의 run/request/완료 증거를 영속 저장소에서 회수한다.
- 화면은 기존 API client와 store에 연결한다. 새로고침 후에도 실행 상태와 검증된 결과 commit/ref를 회수한다. HTTP 연결 상실은 실행 취소/실패 증거가 아니므로 자동 재전송하지 않는다.
- 실제 Codex provider, 자동 스케줄링, 작업 트리 자동 병합은 기존 보류를 유지한다. 결과는 승인한 새 Git 브랜치다.

## 검증·인수

격리 Git/DB 및 실제 HTTP에서 준비의 무변경, 기준/파일 변경 거부, 잘못된 task/run·미승인 시작·지원하지 않는 graph 거부, Origin/CSRF·엄격한 입력 거부, 같은 staging 재전송의 멱등성, 영속 상태/결과 재조회를 검증한다. 화면 연결 후 실제 브라우저에서 준비→기존 승인→실행→검증 결과 확인까지 인수한다. API 구현만으로 화면/전체 운영 완료를 선언하지 않는다.

## 1차 API 결과

`POST /api/v1/tasks/:taskId/execution/prepare`는 schema_version=1, run_id, provider, repository_root, files(path/access/exists), publication_ref, limits, verification을 받는다. 계획과 해시·내용 없는 파일 검사 결과를 반환한다. 응답 계획은 60 KiB 이하로 제한하여 기존 64 KiB staging 본문에 식별자 여유를 둔다. 실행 런타임 구성/모델 인증 준비 상태를 뜻하지 않는다.

`POST .../execution/stage`는 schema_version=1, request_id, nonce, plan을 받는다. 동일 입력에서 현재 계획을 다시 계산하여 검토한 digest와 비교한 뒤 기존 stageTaskExecution을 호출한다. `requested_by`는 서버의 jarvis-control-center다. 기존 `/control/requests/:id/decision`과 `/execute`를 재사용한다.

`GET .../execution`은 task의 최신 workflow 20개와 실행 요청 20개, 각각의 잘린 결과 여부, 검토 계획, 요청 상태, 검증된 과거 완료 영수증을 반환한다. 완료 영수증은 이후 ref가 이동하지 않았다는 주장이 아니다. 새로고침은 파일/Git/provider를 실행하거나 권한을 갱신하지 않는다. 실패 요청의 자동 재실행 안내는 제공하지 않는다.

독립 정적 검토의 PATH 기반 최종 Git 검사와 계획 확대 크기 경계를 수정했다. 동일 pinned Git inspector와 identity/check를 기존 파일 검사에 전달하고 파일별로 현재 작업·시간을 확인한다. 고정 Git discovery에서 최상위 디렉터리도 검증한다. 두 번째 정적 검토 추가 필수 지적 0건이다.

2026-09-08 04:42:44 KST, 실제 built HTTP→Claude CLI 1회→Node verifier/bwrap→서명 proof→새 Git ref→완료 조회를 격리 저장소/키/DB에서 통과했다. 준비의 DB 변경 0, 준비/readiness의 모델 호출 0, 로컬/독립 검사 각 2개 exit 0, 원본 HEAD/index/파일 유지, runtime 설정 제거 후 재조회·재호출의 추가 모델 호출 0을 확인했다. HTTP 승인에는 fixture 키로 만든 단일 사용 서명 영수증을 사용했다. 실제 사용자 브라우저 승인 UI나 운영 배포 인수의 증거로 확대하지 않는다. 로컬 증거는 `.runtime-tmp/approved-task-http-live-smoke.json`이다.

후속은 기존 client/store/작업 화면 연결이다. 준비·staging의 검사 시간과 최대 10분 실행을 고려한 HTTP 대기/연결 상실 표시, 최신 상태 재조회, 검토→승인→실행→결과 브라우저 동선을 완성한다.


## 2차 화면 연결과 통신 실패 처리

작업 상세의 기존 client/store에 파일·검사 입력, 내용 없는 계획 검토, pending 요청,
기존 서명 승인, 실행 환경 확인, 명시 실행, 영속 완료 commit/ref를 연결했다.
입력 변경은 미리보기를 무효화한다. 준비·staging·환경 확인은 45초, 실행은
최대 10분 작업과 사전 검사에 맞춰 660초를 기다린다. 자동 재전송은 하지 않는다.

`POST .../execution/check`는 동일 task/run binding을 검사한 뒤 기존 readiness를 반환한다.
모델 로그인은 검사하지 않으며 provider 호출·DB 변경 없이 구성 가용성만 확인한다.
기존 typed HTTP 오류 매핑을 먼저 유지하고 추가 TASK 오류는 원문 진단 없이 409로 반환한다.

조회는 store의 단일 task resource와 응답 순번 검사를 사용한다. SSE의 task/approvals
변화와 명시 refresh가 같은 자원을 갱신한다. 같은 상세의 재조회 중 기존 내용을 유지하고
실행 resource의 조회 대기 중에는 승인·실행을 비활성화한다. 조회 실패는 보이게 표시한다.

전송한 stage/execute 식별자는 React component가 아닌 dashboard store에 보존한다.
GET 오류로 화면이 제거되거나 작업 이동 후 돌아와도 pending/approved·빈 조회만으로
차단을 해제하지 않는다. 해당 요청의 영속 관측 또는 알려진 입력/구성 거절이 필요하다.
미확정 식별자 128개는 임의로 버리지 않고 추가 전송을 거부한다.
이 보존 범위는 현재 dashboard 인스턴스다. 브라우저 전체 재시작·다른 탭 사이의 전송
이력 공유는 구현하지 않았다. 실제 효과 중복 방지는 서버의 기존 operation/승인 계약이다.

Today와 일반 승인 목록은 task.execute를 직접 승인·실행하지 않고 task_id의 상세로
연결한다. React Router Link로 현재 store를 유지한다. task.execute 실패의 일반 Retry는
화면과 공통 POST 정책에서 not_allowed이며 같은 run/plan의 새 요청을 복제하지 않는다.
다른 명령의 재시도 정책은 유지한다.

2026-09-08 05:19:33 KST 실제 Playwright에서 파일/검사 입력→계획 준비→요청 생성→
승인 목록의 상세 링크→fixture 서명 승인→환경 확인→Claude CLI→검증 결과→페이지
새로고침을 통과했다. provider 1회, 준비/readiness 0회, 로컬/별도 verifier 검사 각각
2개 exit 0, Ed25519 proof 검증과 별도 DB 연결의 동일 완료 영수증 회수가 확인됐다.
결과 commit `9f539dece315b7ce67eeee9a2b8a159dd05b0ac9`, baseline
`db02c4e04ab2a4be31fafc61f151942b09afd9dc`, ref
`refs/heads/codex/actual-fixture-result`. 원본 HEAD/index/파일은 유지했다.
1440×1000·390×844의 계획/결과 네 화면에서 가로 넘침 0, axe serious/critical 0,
콘솔 오류/경고 0이다. Browser plugin not available로 설치된 Playwright를 사용했다.
증거와 스크린샷: `/home/jm/.cache/jarvis-ui-qa-20260908/`.

이는 합성 코드 작업·격리 Git/DB·테스트 승인 키를 사용한 실제 도구 인수다.
운영 서비스 배포, 실제 사람의 서명 발급 장치, Codex provider, 자동 스케줄링,
현재 작업 트리 자동 병합 및 전체 01–25 완료를 의미하지 않는다.
