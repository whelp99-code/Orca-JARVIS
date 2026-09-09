# Scoped 원장 inventory 및 fresh DB 삭제 수정

scoped binding/관찰/settlement가 outbox surface 스캔에서 누락되고 fresh DB 삭제에 남아 FK 오류를 만드는 문제를 재현했다. 기존 surface prefix 및 종속 삭제 순서에 포함하고, 후보만 억제돼도 관찰/settlement를 복사하지 않도록 수정했다.

관련13개 통과(24.21초), 격리 emit/ESLint 통과. 기존 물리 삭제 회귀의5초 timeout은15초로 조정했으며 assertion은 그대로다. 실제 MCP 완료 뒤 별도 프로세스 fresh DB에서 대상5개 테이블0건/원본각1건, FK0, trigger 및 control 기록 보존을 검증했다.

신규 검증은 DB 원장 재구성이며 원문·spool·백업 전체 삭제와 복원 억제 완료가 아니다. 운영 DB/서비스와 기존 migration을 변경하지 않았다.

[상세 보고서](../../second-brain-app/SCOPED-LEDGER-COMPACTION-2026-09-09.md).
