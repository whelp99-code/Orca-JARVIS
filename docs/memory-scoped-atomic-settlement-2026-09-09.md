# Scoped 저장과 원작업의 원자적 완료

settleMemoryScopedCompletion은 현재 MCP 관찰, 원래 권한/현재 철회·suppression, reconciliation lease를 검사하고 수락/관찰/scoped receipt/outbox·candidate settled/control effect·completed·event를 한 DB 트랜잭션에 기록한다. migration080은 scoped 전용 불변 영수증을 추가하며 기존 migration과 legacy 검사 bytes는 유지한다.

readMemoryScopedSettlement는 과거 원래 증거와 영수증/control 효과·event를 대조한다. 완료 후 재호출은 provider 재호출이나 새 효과 없이 결과를 반환한다. 취소된 호출은 거절한다.

관련62개 통과, 최종focused5개 재검사(중복)·격리 emit/ESLint·패키징 통과. 실제 stdio MCP 완료 후 exit73, 별도 프로세스 read-back/settle replay에서 provider 호출0, settlement1/attempt1/FK0과 control completed를 확인했다. 기존 관찰 전용 인수도 통과했다.

운영 인증 공개 쓰기, 실제 에이전트 운영, 새 원장 포함 보존/삭제/복원 inventory 및 혼합 버전/migration 운영 인수는 남는다. 운영 DB/서비스는 변경하지 않았으며 내부 쓰기/인증은 fixture다.

[상세 보고서](../../second-brain-app/SCOPED-ATOMIC-SETTLEMENT-2026-09-09.md).
