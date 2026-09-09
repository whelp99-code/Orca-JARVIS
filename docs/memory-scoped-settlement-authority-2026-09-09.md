# Scoped 원래 전송 권한과 현재 철회 검사

readMemoryScopedSettlementAuthority는 원래 scoped 요청/binding/attempt, 원작업 command/redemption/승인 서명, source와 소비된 범위 검토를 대조한다. 만료는 원래 전송 시점에서 검증하고 현재 철회·suppression을 적용한다. expired control이 uncertain으로 복구돼도 역사 검증이 가능하지만 취소로 철회된 명령은 거절한다. 새 write grant나 control 완료를 만들지 않는다.

신규8개 포함 관련48개 통과(53.36초), 격리 emit/ESLint 통과. 실제 MCP 관찰 뒤 독립 Node 프로세스에서 control 만료 복구·원래 승인 대조·현재 철회 거절을 확인했다. 테스트 철회는 rollback하고 재검증했다. 운영 서비스/DB와 기존 migration은 변경하지 않았다.

현재 읽기·재조정 fence·durable proof와 동일 완료 트랜잭션에 결합하는 scoped settlement/control 연결 및 운영 인수는 남는다.

[상세 보고서](../../second-brain-app/SCOPED-SETTLEMENT-AUTHORITY-2026-09-09.md).
