# Second Brain 취소 상태 프로필 연결

JARVIS 제품 `1598762`, SB 제품 `df9412c`. 상세 증거는 [SB MCP 인수 보고서](../../second-brain-app/CANCELLATION-MCP-ACCEPTANCE-2026-09-08.md)와 [실측 JSON](../../second-brain-app/CANCELLATION-MCP-ACCEPTANCE-2026-09-08.json)을 따른다.

명시적 cancellation-schema6에서 sb_cancellation_status를 호출한다. 기본 task32-schema4와 기존 remember-schema5는 유지한다. 새 artifact second-brain-mcp-v4.json의 schema_version은 6이며 SHA-256은 `8be1ca195f60cb73f05c989d3d5f3e62053020988ccd8bb028cd4d8b442063b4`다. 구 프로필의 새 도구 호출은 spawn 전에 거부한다.

requireCorrectionCancellationStatus는 의향 ID/digest·provider·현재 삭제 이력·접수 시각·상태별 필드를 검사하고, 완료 결과는 기존 cancellation result verifier로 검증한다. 과거 공개키와 철회 목록을 적용하며 처리 cursor는 변경하지 않는다. intent는 호출자가 신뢰하는 저장된 의향이어야 한다.

실제 격리 Node transport→Python MCP에서 pending/완료 조회·MCP 재시작 후 동일 결과·권한 거부·원장 행 불변을 확인했다. MCP 설정에 개인키를 전달하지 않았다. 관련 7파일78검사와 전송/adapter 9파일71검사(중복), backend tsc·변경 ESLint·격리 emit 통과. 운영 dist/설정/서비스는 변경하지 않았다.

남은 P0: 실제 DB snapshot 의향 발급, provider 취소 접수와 전송 경합, exact 결과와 로컬 억제 증거의 cursor 완료, 취소 seq1→정상 V2 seq2. native 사본 수명·검증된 범위·원작업 계보·실제 앱 수집/주입·검색·운영 인수도 유지한다. 자동 취소 route와 lane skip은 활성화하지 않는다.
