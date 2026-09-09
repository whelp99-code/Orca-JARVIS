# Scoped V4 공개 MCP 쓰기 계약 연결

새 scoped-request-write-v1 프로필에서 sb_write_request 한 개를 노출한다. 기존 read v1–v5 및 V1/V2/V3 쓰기 계약·기본 프로필은 유지한다. 요청은 scoped V4, 응답은 원래 scoped acceptance이며 수락은 완료를 뜻하지 않는다.

계약 second-brain-scoped-write-v1.json SHA256:
023cdf5bebc8b96356645a8927dda80b71e8974ce7f4f5300735e63f904aecde

JARVIS transport가 이 프로필을 명시적으로 선택하고 고정 계약/hash와 실제 tools/list를 대조한다. 원래 요청의 canonical V4 codec을 사용한 immutable snapshot을 만들어 caller 변경을 분리하며, 다른 schema·추가 인수·읽기 도구 호출을 송신 전에 거절한다. 요청 인수 크기는32,780바이트(요청32,768+wrapper)다. 기존 단일 write queue·취소·uncertain write 처리 경로를 재사용하며 자동 재송신은 추가하지 않았다.

SB MCP는 서버 고정 [scoped_provider_verifier] credentials_path가 없거나 mcp_scoped_read와 혼합되면 시작하지 않는다. HTTPS 현재 세션·정책/원래 dispatch 검증을 통과한 요청만 기존 단일 수락 원장에 기록한다. 외부 인수로 verifier/session/저장 root를 바꾸지 않는다. 중단/error 응답만으로 수락되지 않았다고 단정하지 않으며 원래 요청을 read v5 상태 복구로 확인해야 한다.

검증:
- JARVIS 관련7파일49개 통과(11.91초); 격리 TypeScript emit·변경 ESLint 통과.
- 새 계약·SHA 파일을 양쪽에 동일 저장하고 별도 임시 패키징 경로에서 고정 digest를 확인했다. 운영 dist/migration은 변경하지 않았다.
- SB 관련17개 통과(4.68초), Ruff 및 새 MCP 모듈 정적검사 통과.
- 실제 JARVIS transport가 별도 MCP 프로세스를 실행하고 실제 TLS/gateway session 검증 후 SB 일반 CLI로 처리했다. 정상 accepted→proved/HTTPS5회, 수락 중 철회 수락 행 없음/2회, 실행 전 철회·로그인 만료 failed/활성 세대 없음/각3회. attempt1/FK0 유지. 실제 결과는 ../second-brain-app/SCOPED-WRITE-MCP-2026-09-09.json.

시간·TLS CA/전달자·원래 dispatch/정책은 임시 fixture다. 운영 계정/Tailnet 배포나 실제 에이전트 A→B 세션 인수를 완료한 것은 아니다. 다음은 운영 실행 설정/자격증명 공급, 실제 A 저장→B 조회 및 전체 M1–M14 인수다. 쓰기 API 오류를 근거로 원래 dispatch를 다시 보내는 방식은 보류한다. Push/배포/운영 서비스 재시작은 수행하지 않았다.
