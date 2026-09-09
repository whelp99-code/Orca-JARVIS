# 최초 세대 이전 수락의 영속 복구

`recoverMemoryScopedJournalAcceptance`가 기존 reconciliation lease와 원래 spool 요청을 대조하고, 새 journal 클라이언트의 현재 권한 검증을 DB 트랜잭션 내부까지 연결한다. 현재 scope·원래 request·lease를 기록 전후 확인한다. 기존 recordMemoryScopedOutboxAcceptance를 재사용하여 acceptance와 provider_accepted 이벤트를 함께 기록하며 새로운 원장이나 migration은 추가하지 않았다.

클라이언트 `withRecoveredRequestStatus`는 신뢰된 동기 소비자에게만 현재 권한 refresh를 제공하며 callback 반환 후 폐기한다. 이 refresh는 로컬 권한을 다시 검증하고 provider 조회 결과를 갱신하거나 권한 유효기간을 연장하지 않는다.

pending/failed는 원래 수락 사실만 기록한다. not_found는 관찰 결과만 반환하며 전송 시도나 완료 상태를 변경하지 않는다. failed/error/not_found를 외부 효과가 없었다는 증거로 사용하거나 자동 재전송하는 기능은 보류한다. 작업은 reconciling을 유지한다.

검증:
- 관련 6파일 **41개 통과 / 32.37초**. 이 안에 신규 복구 7개와 journal 소비자12개가 포함된다.
- 수락 기록 이후 철회·취소·lease 만료 주입에서 acceptance/event 전체 rollback, stale lease의 provider 호출0, 정상 replay/event1/attempt1 및 callback 밖 refresh 거부.
- 초기 신규7실패는 시험 시계가 읽기 키 valid_from 이전인 문제와 outbox recovery가 attempt의 dispatching 값을 유지하는 기존 동작에 대한 잘못된 기대였다. 실제 유효 시각과 원래 attempt 상태로 fixture를 수정했다. 권한/상태 제약 완화 없음.
- 격리 TypeScript emit·변경 ESLint·diff 및 인수 스크립트 문법 검사 통과.
- 실제 자비스 원장/spool에서 한 dispatch를 만든 뒤 Python provider 수락→실제 MCP journal 조회→원래 자비스 DB 기록을 연결했다. pending/failed 각각 커밋 후 exit73→새 Node/MCP 프로세스에서 replayed=true. attempt1, acceptance event1, FK0, outbox reconciling과 기존 reconciliation lease 유지.
- 동일 인수에서 MCP 재시작 결과 일치, provider key/issuer policy 철회 차단도 확인했다. 원래 쓰기 권한과 읽기 세션·시계는 fixture다. 운영 로그인/Tailnet·실제 사용자 A→B 인수가 아니다.

재현: JARVIS cwd에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-journal-recovery-acceptance.mjs <격리 빌드 경로>`. 실제 결과는 SB `SCOPED-JOURNAL-RECOVERY-2026-09-09.json`에 기록했다.

SB 제품은 변경하지 않았다. 이전 전체 회귀1,354통과/2skip(embeddings 제외)은 과거 기준선이며 이번41개와 합산하지 않는다. 원장 수락 복구의 library 조합은 구현했지만 운영 worker의 전체 실행 설정, 실제 인증 세션 공급, A 저장→B 새 세션 회수, 실패의 최종 처분·삭제/복원·검색/GUI 등 M1–M14 인수는 남는다. Push/운영 서비스/운영 DB 변경은 없다.
