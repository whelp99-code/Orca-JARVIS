# 기억 projection의 명시적 초기화와 읽기 경계

기준일: 2026-09-08. 개선 목록 08.

## 결정

MemoryProjectionLineage 생성자는 재구축하지 않는다. 조회는 준비 상태를 검사하고,
pending/failed/rebuilding 상태에서는 `MEMORY_PROJECTION_AUTHORITY_NOT_READY`를 반환한다.
빈 command/task 목록과 없는 ID의 조회도 같은 경계를 적용한다. HTTP는 이 오류를
503으로 전달하고 원본 내용·내부 오류를 응답에 포함하지 않는다.

초기화/복구는 다음 관리 명령으로 수행한다.

```bash
node dist/src/cli.js db rebuild-projections --db /absolute/path/to/authority.sqlite
```

호출자는 해당 DB의 관리 권한을 가진 로컬 운영자다. 이 명령은 기존 `db migrate`처럼
명시적인 로컬 관리 경로이며 HTTP나 일반 GET에서 자동 실행하지 않는다. 기존 migration
검증을 먼저 통과해야 한다. 이미 준비된 DB에서는 데이터 쓰기를 수행하지 않는다.
운영 DB에서의 실행은 운영 변경 절차와 사용자 지시를 따른다.

## 원자성과 기존 데이터

- 공개 `MemoryProjectionAuthority.initialize(now)`가 IMMEDIATE transaction 안에서 현재
  상태를 다시 확인한다. 명시적 호출에 한해 중단된 rebuilding도 재시도한다.
- 기존 context의 기억 참조를 다시 대조해 dependency를 보충하거나 quarantine에 기록한다.
  기존 dependency/suppression/quarantine은 삭제하거나 교체하지 않는다.
- 마지막 ready 전환까지 하나의 transaction이다. 중간 오류가 발생하면 새 계보·상태 변경을
  rollback한다. 이전 failed/pending/rebuilding 상태는 보존되며 다음 명시 호출로 재시도한다.
- singleton이 없거나 clock이 유효하지 않으면 초기화하지 않는다. 미확인 상태를 ready로
  만드는 복구나 migration 바이트 변경은 수행하지 않는다.
- migration 049의 기본 상태는 ready다. 정상 DB의 조회·쓰기 계약과 구버전 테이블 부재를
  허용하던 binding/daily-loop fallback은 유지한다. 테이블 존재를 ready 상태로 간주하지 않는다.

## 준비되지 않은 상태의 효과 차단

기존 객체도 ready→pending 전환을 관측할 수 있으므로 각 public suppression/lineage 조회에
준비 상태 검사를 적용한다. bind/inherit·suppression activation은 쓰기 transaction 안에서
검사한다. 추천·알림·상태의 binding helper는 부모 목록이 비어도 준비 상태를 검사한다.
알림 claim/settle은 준비 상태 확인 이후에만 원장을 변경하고 외부 resource 검사로 진행한다.
초기화 내부의 계보 보충은 별도 내부 경로를 사용하여 rebuilding 중 public guard를 우회하지 않는다.

오류를 409로 변환하던 memory/task/recommendation HTTP 처리부에서는 NOT_READY를 상위
503 처리부로 전달한다. 조회 실패를 빈 목록이나 성공 응답으로 바꾸지 않는다.

## 검증 범위

- 수정 전 첫 조회 회귀 4개 실패를 재현했다.
- pending/failed/rebuilding의 첫 조회, 빈 목록, 없는 ID, populated HTTP 목록·상세,
  새 객체 생성과 기존 객체 사용 모두 DB 쓰기 0을 검사한다.
- 초기화 중 강제 오류의 rollback, quarantine 보존, 정상 재시도, ready 재호출의 쓰기 0,
  잘못된 clock·singleton 부재와 알림 외부 검사 미호출을 검사한다.
- 격리된 실제 서버와 CLI subprocess에서 세 상태의 첫 GET 503→관리 명령 성공→GET 200,
  관리 명령 재호출 시 persisted singleton 불변을 확인했다.

실사용 증거와 재현 스크립트는
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/projection-live-probe.json` 및
`projection-live-probe.mjs`에 있다. 운영 DB/서비스/release를 변경한 검증은 아니다.
전체 결과 수와 남은 01–25 범위는 개발 실행 원장을 따른다.
