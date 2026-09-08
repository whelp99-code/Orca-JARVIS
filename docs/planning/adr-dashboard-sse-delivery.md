# P2-17 대시보드 SSE 전송 상한과 재접속

2026-09-08. 범위: 서버의 구독 연결, 재조회 알림 병합, replay/snapshot 복구.

## 확인한 문제

기존 sink는 `ServerResponse.write(false)`를 무시했다. 빌드된 HTTP route와 읽기를 멈춘
TCP 클라이언트에20,000개 알림을 연속 발행했을 때 writable 버퍼가5,296,798bytes가 됐고
첫 false 뒤에도19,748회 추가로 썼다. 운영 서버나 운영 데이터를 사용한 검증은 아니다.

## 전송 계약

- `sse-bounded-sink.ts`는 프레임16KiB, Node writable 버퍼128KiB 상한을 둔다.
  payload뿐 아니라 HTTP chunk framing 여유32bytes를 포함해 write 전에 검사한다.
  이는 이 연결의 writable 버퍼 제한이며 프로세스 RSS나 커널 TCP 버퍼 전체 상한이 아니다.
- write가false를 반환하면 drain까지 추가 프레임을 쓰지 않는다. 큐에 프레임을 저장하지 않고
  추가 재조회 알림이 있었는지만 기록한다. heartbeat는 이 표식을 만들지 않는다.
- drain에서 밀린 알림을 새 revision의 전체 snapshot1개로 합친다. snapshot은 기존
  overview/tasks/agents/approvals 및 personal/memory 토픽을 포함하고 클라이언트는 정본을 다시 읽는다.
  전송이 다시 막히면 새 drain 기한을 적용한다. 정상 연결은 기존 영향 토픽만 받는다.
- drain이5초 동안 없으면 해당 연결을 destroy하고 구독·heartbeat·기한을 해제한다.
  기한은 추가 알림이나 heartbeat로 연장하지 않는다. 프레임/버퍼 초과·소켓 오류도 해당 연결을 종료한다.
- 브라우저는 기존 EventSource 재접속을 사용한다. Last-Event-ID가 replay128개 안에 있으면
  이후 알림을 받으며, 없거나 오래됐으면 전체 snapshot으로 복구한다. 알림은 실행 명령이나 승인 증거가 아니다.
- Hub는 최대32개 토픽 및 토픽별256 UTF-8 bytes를 적용하고 JSON escape를 포함한 실제
  프레임 크기도 검사한다. 상한을 넘는 알림은 전체 snapshot으로 바꾼다. 공유 replay는
  최대128개·프레임당16KiB로 제한한다. 한 subscriber의 write 예외는 다른 subscriber 전송을 중단하지 않는다.
- 연결 초기 snapshot/replay 중 종료돼도 반환된 unsubscribe를 적용하고 heartbeat를 시작하지 않는다.
  close/error/drain이 뒤늦게 도착해도 추가 전송·중복 정리를 하지 않는다.

## 검증 범위

신규7개 검사는20,000개 알림 병합, 기한 비연장·drain 취소, heartbeat 처리, UTF-8/버퍼 상한,
초기 연결/heartbeat 실패 정리, 느린 replay, 구독자 실패 격리,32개 토픽과 escape 확장 상한을 포함한다.
관련 backend7파일19개, dashboard29파일162개가 통과했다. lint의 heartbeat 재할당 경고는
cleanup에서 해제된 타이머 참조를 비워 수정했으며 신규7개를 다시 통과했다.

실제 빌드된 대시보드 서버·paused TCP 클라이언트·Chromium으로 격리 DB에서 검증했다.
총140,000개 발행 중 느린 연결의 실제 write11,571회, false41회, writableNeedDrain이
true인 동안 추가 write0회, 최대 writable 버퍼65,706bytes였다. 첫20,000개 burst의
최대값은65,616bytes이고 drain 미복구 연결은5,002ms 뒤 종료됐다.
브라우저 연결을 종료한 사이 작업을 추가하고 기존 ID를 replay에서 밀어낸 뒤 자동 재접속을
확인했다. open2/snapshot2/reconcile1, 카드1→2, 재조회DB쓰기0/page error0이었다.
최초 probe의 별도 blocked 플래그는 drain listener 등록 순서 때문에 정상 drain snapshot
쓰기를 오인했다. 최종 probe는 write 직전 Node의 writableNeedDrain을 직접 확인한다.
증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/sse-live-probe.mjs/json`,
`sse-regression.log`, `sse-cleanup-final.log`, `sse-dashboard.log`. 임시 DB/브라우저 제거 완료.
최종 backend build/typecheck/lint exit0, 독립 정적 리뷰의 필수 결함0.

이 단위는 전체 테스트 완료나 운영 배포를 뜻하지 않는다. 정상 수신 클라이언트에서 짧은 시간에
여러 알림이 올 때의 HTTP 재조회 중복 병합과 조회 규모 최적화는 별도 후속 범위다.

## 기본 대시보드 HTTP 갱신 — 2026-09-08 후속

기존 store에서 동기 알림1,000회와 수동 refresh1회가 tasks GET1,001회를 만들었고,
두 수동 조회의 응답 순서를 바꾸면 이전 결과가 최신 화면을 덮어썼다.

- overview/tasks/agents/approvals별 진행 중 읽기1개와 공유 후속 읽기1개를 둔다.
  알림마다 대기 Promise 체인을 누적하지 않으며 서로 다른 리소스는 독립 진행한다.
  수동 refresh는 자신이 요청한 후속 읽기의 완료를 기다린다.
- snapshot도 완료 대기1개와 후속1개로 병합한다. 시작 시 연결 버전을 고정하여
  조회 중 발생한 disconnect를 뒤늦게 live로 변경하지 않는다.
- 사용하지 않고 버리던 task 상세 GET을 없앤다. task:<id>는 canonical tasks를 갱신하며
  상세 화면의 기존 task revision과 선택한 execution 조회로 전달한다.
- 선택한 execution 읽기도 진행1개/후속1개로 제한한다. 무효화 시 sequence를 먼저
  올려 이전 결과가 refreshing/실행 보호 상태를 해제하지 못하게 한다.
- 일반 GET은15초 AbortSignal deadline으로 fetch와 body를 함께 중단한다. store 종료는
  현재 요청을 abort하고 대기 batch를 해제한다. execution은 기존 transport deadline과
  종료 signal을 합성한다. 종료된 요청의 결과는 generation/selection fence로 거부한다.
  단순 timeout Promise.race로 슬롯만 비우고 실제 요청을 남기지 않는다.

적용 범위는 기본 대시보드와 선택한 작업 실행 조회다. 개인 대시보드의 공통 snapshot
조회 병합과 memory 화면은 후속으로 남긴다. memory의 즉시 개인정보 철회·검색 취소·
정정 완료 순서를 검증하기 전에는 동일 큐를 적용하지 않는다. 기존 기능은 유지한다.

검증: 제품 frontend30파일168개 통과(31.07초), 마지막 테스트 정리 후 해당2파일8개
재통과(1.82초), lint/typecheck/dashboard build exit0, 독립 리뷰 잔여 필수 결함0.
실제 Chromium에서reconcile1,002회/snapshot1회를 수신했고, 지연시킨 tasks 읽기는
진행1회+후속1회였다. 같은 시간 agents/approvals 각각1회 완료, 화면 task1→2,
재조회DB쓰기0/pageErrors0을 확인했다. 이는 격리 합성 DB의 실제 브라우저 검증이다.
실제 HTTP 부분 JSON 응답은15,007ms에 abort됐고 대기 알림10,000회는 후속 요청1회로
이어졌다(총 요청2/완료1/중단 body 연결닫힘). 증거는
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/client-live-probe.mjs` 및 `.json`,
`client-coalescing-browser.png`, `client-coalescing-*.log`에 있다.

## 개인 대시보드 snapshot 갱신 — 2026-09-08 후속

today/decisions/notifications/health는 기존처럼 한 snapshot으로 공개한다. 공통 queue를
재사용해 진행 중 snapshot1개와 공유 후속1개로 제한하고, 네 HTTP 요청이 모두 끝난 뒤
슬롯을 반환한다. 하나의 실패가 나머지 요청을 남긴 채 새 묶음을 시작하지 못하게 한다.
각 요청은 기존10초 transport deadline과 store 종료 signal을 함께 사용한다.

요청 접수 시 sequence를 올려 무효화된 이전 snapshot이 최신 결과를 덮어쓰지 못하게 한다.
disconnect/잘못된 SSE envelope 이후에는 진행 중 HTTP가 stale 표시를 해제하지 못한다.
memory.privacy.v1 수신 시 개인 화면의 캐시 data를 동기적으로 제거하고, 최신 요청으로
확인한 결과만 다시 공개한다. memory-store의 검색·검토·철회 상태기계는 별도 범위로 유지한다.

제품 frontend30파일174개/32.16초, lint/typecheck/build exit0, 독립 리뷰 필수 결함0.
실제 Today 브라우저에서 개인 SSE1,001개 수신 중 네 API 각각 진행1+후속1로 제한,
새 추천0→3개 표시, privacy 알림 직후0개·fresh read 후3개를 확인했다. 이 privacy
검사는 합성 무효화 이벤트이며 서버 원본 삭제 인수가 아니다. 재조회DB쓰기0/pageErrors0.
실제 partial HTTP4개를 store stop으로 모두 닫았고, 한 API500·다른 API partial body의
동시 실패에서는10,009ms에 지연 요청을 종료한 뒤 후속4개가 완료됐다(총8요청).
증거 루트의 `personal-live-probe.mjs/json/log`, `personal-coalescing-*.log`,
`personal-privacy-refresh.png`, `personal-coalescing-browser.png`를 참조한다.
기존1초 DB 변경 관찰 주기는 유지한다. 운영 서비스 변경0.

## 개인·기억 HTTP 응답 수신 상한 — 2026-09-08 후속

두 클라이언트의 기존64KiB 검사는 response.text() 완료 후 실행돼 EOF가 없는 초과
응답을 중단하지 못했다. readBoundedJson으로 수신 중 제한을 적용하고, 초과 chunk를
전체 복사하기 전에 거부한다. 앱이 할당하는 입력 버퍼는65,539bytes이며 UTF-8 BOM
3bytes를 제외한 기존 decoded/reencoded payload 제한65,536bytes를 보존한다.
브라우저가 전달하는 chunk·압축 해제·디코딩 문자열·JSON 객체·RSS 전체 상한은 아니다.
잘못된 UTF-8의 replacement 확장도 마지막 바이트 검사에 포함한다.

초과/중단 시 reader를 취소하고 lock을 해제한다. 주입된 stream의 취소가 실패하거나
끝나지 않아도 원래 오류를 반환한다. personal의 VALIDATION_ERROR, memory의
MEMORY_RESPONSE_TOO_LARGE, 기존 개인10초 deadline/caller abort, 요청/승인 계약을
유지한다. 쓰기 요청의 응답 실패를 재전송하거나 실행 실패 확정으로 해석하지 않는다.
memory의 별도 deadline과 privacy 상태기계/조회 병합은 이번 변경에 포함하지 않는다.

frontend31파일183개/36.47초, lint/typecheck/dashboard build exit0, 독립 정적 리뷰
필수 결함0. 실제 Chromium/native HTTP에서 개인 GET·기억 GET·기억 POST 각각 plain/gzip
6건을3~5ms에 거부하고 각 연결1회 닫힘·요청1회(자동 재전송0)를 확인했다. gzip은
wire118bytes/decoded70,012bytes이며 HTTP EOF를 주지 않았다. POST는 격리 HTTP
응답 fixture만 사용했고 실제 기억 삭제를 실행하지 않았다. 정확64KiB 한글+BOM과
이후 정상 두 클라이언트 조회도 통과했다.

실제 built Today 화면은 gzip 초과 응답2건/연결닫힘2건 후 SSE 재조회로 no_data 화면에
복구했다. GET DB쓰기0/pageErrors0, 임시 데이터 제거. 최초 probe는 제품 문구의
"is"를 누락한 selector 때문에 timeout됐으며 실제 문구로 수정 후 exit0이다.
증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의
`response-budget-live.mjs/json/log`, `response-budget-live-selector.log`,
`response-budget-recovered-browser.png`, `response-budget-{tests,lint,types,build}.log`.
