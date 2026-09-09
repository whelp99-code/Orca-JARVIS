# Scoped 완료 관찰의 영구 기록

범위 지정 요청의 완료 관찰은 legacy settlement 식별자/receipt로 변환하지 않는다. 원래 scoped binding, dispatch attempt, 재조정 fence와 현재 읽기 관찰을 별도의 append-only 테이블에 결합한다. 기록은 완료 성공이나 새 읽기 권한을 뜻하지 않는다.

클라이언트가 검증한 관찰의 소비 범위 안에서 현재 읽기 권한을 재검사할 수 있게 한다. DB 기록자는 동일 IMMEDIATE 트랜잭션 안에서 원래 요청/lease를 확인하고 수락과 내용 없는 관찰 증거를 기록한다. commit 직전 현재 권한과 lease를 다시 검사하며 실패 시 전체 rollback한다. MCP 네트워크 호출 중에는 DB 트랜잭션을 유지하지 않는다.

기존 migration은 변경하지 않는다. 새 migration079에 원래 outbox/attempt 참조와 fence별 불변 기록을 추가한다. 같은 fence의 같은 증거는 replay, 다른 증거는 conflict로 거절한다. 자동 settled/control completed는 원래 command/승인·현재 철회/suppression 검사와 후속 scoped 증거 재구성 구현 후 연결한다.
