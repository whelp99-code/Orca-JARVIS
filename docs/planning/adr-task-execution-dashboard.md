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
