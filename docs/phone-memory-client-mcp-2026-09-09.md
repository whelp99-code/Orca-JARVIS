# 인증된 자비스 기억을 읽는 stdio MCP 클라이언트

개발 연결부는 `src/phone-memory-client-mcp.ts`이며 기존 `/api/v1/memory/context` HTTPS API를 호출한다. 별도 기억 DB나 로그인 서비스는 만들지 않는다. 서버에 이미 배정된 agent와 현재 로그인·정책 검사가 적용된다. 모델 입력으로 URL·쿠키·agent ID·권한을 받지 않는다.

실행은 검증한 빌드의 절대 경로로 지정한다.

```text
node /absolute/release/dist/src/phone-memory-client-mcp.js /absolute/private/client-credentials.json
```

MCP 도구는 `jarvis_memory_context` 하나다. 인수는 `query`(서버와 같은 NFC/공백·UTF-8 512bytes 검사), `limit`(1–32, 기본8), `max_bytes`(1024–65536, 기본16384)다. 응답은 기존 memory-reference-v1 문맥과 출처를 그대로 반환한다. `authority:none`, `trust:untrusted`인 참고 기억이며 작업 성공·승인 증거가 아니다. 자동 수집·자동 주입·쓰기 도구를 제공하는 연결부로 해석하지 않는다.

자격증명 JSON은 `origin`, `cookie_id`, `csrf_token`, 선택 `ca_file`만 허용한다. origin은 경로 없는 정규 HTTPS origin, 두 토큰은 각각43자 URL-safe 값이다. 자격증명과 선택 CA는 현재 사용자 소유의 비공개 디렉터리/일반 파일이어야 하며 심볼릭 링크·여러 하드링크·공개 권한을 거부한다. 기존 파일 검사기를 재사용하고 권한을 자동 수선하지 않는다. origin과 CA를 포함한 파일을 호출마다 다시 읽는다. 현재 로그인 자격증명 공급·교체는 운영 구성의 별도 미완료 항목이다. 토큰을 명령행 인수나 모델 프롬프트에 넣지 않는다.

HTTPS 인증서 검증, 20초 제한, 호출 취소, 응답 전체 크기 제한을 사용한다. redirect·압축 응답·잘못된 JSON·변조 digest·다른 query digest·토큰이 포함된 응답을 거부한다. JSON escape를 해석한 뒤에도 토큰 포함 여부를 검사한다. 실패는 일반 오류로 반환하고 자동 재시도하지 않는다. MCP 프로토콜은 고정 의존성 `@modelcontextprotocol/sdk@1.30.0`으로 처리하며 자체 JSON-RPC 구현을 추가하지 않았다.

## 검증

- 실제 임시 HTTPS 서버와 SDK client: 최초15검사 중2실패(다른 질문 응답, escape된 토큰) 재현 후 수정, 최종15통과.
- 관련 context CLI9/오류 분류16 포함 고유40통과, TypeScript 격리 emit 및 변경 파일 ESLint 통과.
- 독립 stdio 프로세스2개와 실제 Claude Code2.1.261에서 TLS→현재 gateway session→CLI→SB scoped MCP를 통해 각2records 회수. 같은 원문·버전·출처를 비교했다. 테스트 전달자·정책·시계·합성 자료를 사용했으며 운영 배포는 아니다.
- Codex 실제 시험은 계정 usage limit으로 `turn.failed`, 도구 호출 전 중단됐다. 이번 Codex 지원 완료를 주장하지 않는다.
- 테스트 PEM 파일은 공개된 폐기 가능한 테스트 전용 인증서/키다. 운영 신뢰 저장소나 자격증명으로 사용하지 않는다.

SB 인수 스크립트 `scripts/scoped-mcp-acceptance.py <isolated-jarvis-build>`가 실제 provider를 만든다. 기본은 독립 SDK stdio 클라이언트2개를 검사한다. `SB_PHONE_NATIVE_ACCEPTANCE=claude`는 실제 Claude를 추가하고, `=1`은 Claude와 Codex를 모두 요구한다. `=1`에서 실제 클라이언트 실패는 전체 실행을 실패 처리한다. native 시험은 기존 CLI 로그인과 모델 사용량이 필요하며 임시 MCP 설정만 사용한다.

이 구현은 실제 인증 경로의 읽기 연결 단위다. 실제 A의 scoped 쓰기→완료→B 새 로그인 회수, native 세션 보존·삭제, 자동 주입, 운영 Tailnet/서비스 및 모든 M1–M14 인수는 남는다. 해시 검사는 응답 결합 검사이며 본문 사실의 진실성이나 작업 성공을 보증하지 않는다.
