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
기존1초 DB 변경 관찰 주기는 유지한다. 운영 서비스 변경0.
