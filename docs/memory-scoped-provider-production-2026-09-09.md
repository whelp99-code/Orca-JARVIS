# Scoped provider의 서버 세션·현재 정책 조합

createProductionScopedProviderVerifier는 서버가 소유한 authenticated_session callback과 현재 파일 쓰기 정책, 기존 authority DB/private spool/원래 전송 검증을 조합한다. 요청 본문의 principal/agent/session 값을 인증 callback으로 복사하지 않는다. 매번 정책과 원래 전송을 다시 확인하며 key/grant/session/DB row/transport를 생성하지 않는다.

신규 조합 및 기존 provider 검증11개 통과(12.25초), 격리 TypeScript emit/ESLint 통과. 서버 세션 변경·없음·현재 파일 정책 철회에서 거절을 확인했다. 실제 Python admission/execution callback은 이 조합의 독립 Node 프로세스 결과를 사용하고, SB의 새 strict decision parser로 요청·범위·시간·만료를 검사한다. 정상 proved, admission 중 철회는 수락 row 없음, 실행 전 철회는 활성 세대 없음으로 확인했다.

인증 세션은 fixture이며 공개 MCP v4 쓰기 노출이나 운영 인증 endpoint 완료가 아니다. 판정 객체의 hash만으로 발신자를 인증하지 않는다. 고정된 신뢰 채널과 실제 서버 세션 소유권을 갖춘 공개 transport 연결이 다음 단계다.

[상세 보고서](../../second-brain-app/SCOPED-PROVIDER-PRODUCTION-2026-09-09.md).
