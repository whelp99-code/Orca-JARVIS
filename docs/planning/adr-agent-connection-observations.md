# 에이전트 연결 관측과 진행 상태 분리

기준일: 2026-09-08. 개선 목록 05 구현, 14의 supervisor 경계 정리.

## 문제와 판정

기존 대시보드는 등록된 binding마다 `live`를 반환했다. 등록·진행 projection은 현재
터미널 연결의 증거가 아니다. 관측은 supervisor가 저장하고 HTTP 조회는 이를 읽는다.

| 상태 | 조건 |
|---|---|
| unknown | 관측 없음, 연결 확인 불가, session/incarnation 불일치, 미래·잘못된 시각 |
| live | 일치하는 binding의 구조화된 연결 성공, 관측 후 120초 미만 |
| offline | 일치하는 binding의 명시적 연결 해제, 관측 후 120초 미만 |
| stale | 유효한 연결 관측 이후 120초 이상 경과 |

120초는 이 구현의 표시 TTL이다. 실제 모델 인증·작업 실행 준비 또는 실행 성공을
뜻하지 않는다. 진행 상태가 running이어도 연결 해제는 offline이며 진행 unknown이어도
실제 터미널 연결이 확인되면 live다. UI의 에이전트 카드는 live만 센다.

Orca list의 handle/incarnation/PTY/worktree를 등록 binding과 대조하고 read의 handle과
정상 status를 확인한다. 현재 Orca 1.4.197의 `running`과 기존 계약 fixture의 `ok`를
허용한다. 다른 응답은 cursor를 전진시키지 않는다. 목록 누락은 offline 증거가 아니다.
일시적인 `ORCA_CLI_FAILED`는 unknown 관측으로 저장한다. JSON/schema/권한 오류는
기존 실행 서비스의 실패 계약을 유지해 전파한다. 오류 시 남은 이전 관측에는 TTL이 적용된다.

## 저장·복구 호환성

- 새 migration 067만 추가한다. 이전 SQL 바이트는 유지한다. 기존 cursor의 connected는
  NULL이며 새 관측 전까지 unknown이다. 0/1/NULL을 기존 cursor transaction 안에서 기록한다.
- observation digest는 connected가 제공될 때 이를 포함한다. 동일 관측은 보고서를 추가하지
  않지만 updated_at을 갱신한다. 연결 전환은 같은 cursor에서도 새 변경이다.
- 새 보고서는 payload version 3이며 previous_report_id를 payload 자체에 포함한다.
  동일 상태로 재연결해도 report ID와 payload digest UNIQUE가 충돌하지 않는다.
  체인 선행 보고서는 IMMEDIATE transaction 안에서 선택한다.
- 기존 v2 미전달 보고서는 ID·payload·digest 바이트 그대로 먼저 복구한다. 미전달 보고서가
  있으면 새 관측에 앞서 재전달하는 기존 순서를 유지한다. 현재 내부 소비자는 보고서를
  불투명 envelope로 전달·ack하며 v2 전용 본문 파서는 확인되지 않았다.
- public LiveSupervisor 진입점은 유지하고 binding, observation, report/ack, resume 정책의
  도메인별 구현으로 분리한다. 터미널 전송 권한을 연결 상태에 추가하지 않는다.

## 검증과 한계

자동 회귀는 신규/기존 binding, 재연결, TTL 경계, 잘못된 시각·신원, transport 실패,
잘못된 read 응답, schema 오류 전파, v2 복구, DB 재개방, HTTP list/detail의 일치 및
읽기 쓰기 0을 확인한다. React 카드의 live-only 집계도 검사한다.

실제 Orca 읽기 전용 list 2회/read 1회와 격리 JARVIS DB·HTTP에서
unknown→live→stale→unknown을 확인했다. stale은 120초 진행시킨 주입 시계,
마지막 unknown은 주입한 CLI 실패다. list/detail 조회마다 DB 쓰기 0, 터미널 변경 0,
실패 후 live 수 0, 격리 DB 제거를 확인했다. provider/session은 검사 메타데이터이며
해당 터미널의 모델 종류·인증 또는 실제 작업 실행을 검증한 것은 아니다.

실사용 스크립트·결과: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/agent-live-probe.mjs`
및 `agent-live-probe.json`. 운영 DB migration·서비스 재시작·릴리스 전환은 수행하지 않았다.
