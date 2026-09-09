# Scoped 저장 결과와 control 완료의 원자 기록

기존 scoped 관찰/역사 proof/원래 권한 검사를 하나의 동기 DB 트랜잭션에 결합한다. MCP 조회는 트랜잭션 전에 완료한다. 같은 트랜잭션에서 수락/관찰, scoped 전용 settlement receipt, outbox/candidate settled, control completed 및 event를 기록한다. 실패 시 전체 rollback한다.

기존 event 테이블의 artifact_observed/settled 형식과 상태 전이 trigger는 재사용하되 receipt는 scoped 전용 domain과 원래 관찰/권한 결합을 사용한다. legacy receipt로 변환하거나 기존 legacy 검사를 제거하지 않는다. 새 migration080에 immutable scoped settlement를 기록한다. 재시작 시 terminal read-back은 기록된 결과의 대조이며 새 성공 효과를 만들지 않는다.
