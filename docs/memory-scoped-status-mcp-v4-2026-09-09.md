# Scoped read v4 요청 상태 연동

명시적 `scoped-record-read-v4` 계약과 `client.requestStatus(request, acceptance)`를 추가했다. 원래 요청 전체에 결합된 memory_status claim과 현재 정책을 검사하고, provider의 상태/proof/receipt를 원래 수락과 대조한다. 정책 schema v3의 명시적 sb_request_status grant가 필요하다. 기존 v1/v2/v3 계약 바이트·기본 v2를 유지한다.

새 checksum: `707ea8dcbdc2aebe0aaa5c90743ebb247adde9d469dd51a0564c2cb8728d53e2`. 격리 패키징에서 네 읽기 프로필의 파일/해시가 일치했다. J 확대72통과/22.59초, 타입 보정 후 소비자37통과/18.61초(중복), 격리 emit·변경 ESLint 통과. SB 전체1,255통과/2skip/223.60초·Ruff 통과.

실제 production 구성 함수→감독되는 stdio MCP에서 v4 상태 및 정확한 artifact/분류 조회, MCP 재시작 후 동일 응답, 양측 정책 철회 거절을 확인했다. 기존 v2/v3도 독립 fixture에서 재검증했다. 인증 세션·키·시계는 fixture이고 운영 설정은 바꾸지 않았다.

현재 proof의 과거 generation과 현재 읽기 generation을 동일하다고 요구하지 않는다. 과거 완료와 현재 artifact는 별도 검증해야 한다. 자동 settled/control completed는 미연결이다. 편의 API가 acceptance를 요구하므로 수락 응답 자체가 유실된 attempt의 복구, 최초 활성 세대 이전 조회, 공개 쓰기 전송·운영 인수도 남는다.

[통합 보고서](../../second-brain-app/SCOPED-STATUS-MCP-V4-2026-09-09.md), [실제 v2/v3/v4 결과](../../second-brain-app/SCOPED-STATUS-MCP-V4-2026-09-09.json).
