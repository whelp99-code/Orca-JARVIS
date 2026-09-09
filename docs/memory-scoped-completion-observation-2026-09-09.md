# Scoped 완료와 현재 기억의 통합 관찰

`readRememberedCompletion(request)`는 read v5로 상태→artifact→상태를 조회한다. proved 상태/proof/receipt 불변, 원래 요청과 정확한 본문/출처/분류, 마지막 상태와 artifact의 현재 generation 일치를 검사한다. 세 호출의 인증 문맥을 대조하고, 반환 전 각 메서드의 현재 권한을 재검사한다. 재검사 때 짧아진 만료 시각도 결과에 반영한다.

과거 proof의 generation을 현재 active generation과 무조건 같다고 요구하지 않는다. 현재 정확한 기억을 읽었는지가 별도 조건이다. 결과는 remembered_completion_observed이며 outbox/control 완료나 재사용 가능한 grant가 아니다.

검증: 신규11개 포함 관련67 passed/25.81초, 격리 emit·변경 ESLint 통과. 실제 production client→stdio MCP에서 통합 관찰, 재시작 후 일치, 양측 정책 철회 거절, 수락 기록 후 exit73/새 프로세스 replay와 attempt1/event1/FK0을 확인했다. 인증·내부 쓰기는 fixture이며 운영 배포하지 않았다. SB 제품 코드는 변경하지 않았다.

기존 memoryOutboxControlProof는 legacy 식별자와 receipt를 요구하므로 이를 scoped 결과에 직접 적용하는 방식은 보류한다. 원래 scoped binding/attempt와 현재 관찰의 durable 결합, 원래 command/승인·철회 검증, scoped reconcile fence와 원자 완료, control 증거 재구성은 다음 구현 범위다.

[상세 보고서](../../second-brain-app/SCOPED-COMPLETION-OBSERVATION-2026-09-09.md), [실제 결과](../../second-brain-app/SCOPED-COMPLETION-OBSERVATION-2026-09-09.json).
