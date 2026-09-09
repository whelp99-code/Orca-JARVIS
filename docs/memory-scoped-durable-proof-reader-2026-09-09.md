# Scoped 완료 관찰의 역사 증거 재구성

readMemoryScopedCompletionProof는 현재 reconciling 요청의 원래 spool/binding/attempt와 관찰 원장의 canonical JSON/hash/ID를 대조한다. 수락 event, provider proof/receipt, source 분류·프로젝트, generation/record 식별자와 시간 순서를 재검증한다. 완료나 현재 권한을 부여하지 않는 completion_evidence_consistent를 반환한다.

신규12+관련46=58개 통과, 격리 emit/ESLint 통과. 실제 MCP가 기록한 관찰을 별도 Node reader에서 읽기 권한 만료 후 복원했고 다른 provider는 거절했다. DB 상태는 reconciling, 관찰1/attempt1/수락event1/FK0이다. 원문 bytes 재생이나 발신자 인증을 새로 수행하지 않으며 trusted local ledger와 원래 인증된 MCP 관찰을 전제로 한다.

최종 scoped settlement/control 및 원래 command/승인·현재 철회/suppression 연결은 남는다. 운영 DB/서비스와 기존 migration은 변경하지 않았다.

[상세 보고서](../../second-brain-app/SCOPED-DURABLE-PROOF-READER-2026-09-09.md).
