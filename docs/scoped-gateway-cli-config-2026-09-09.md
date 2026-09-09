# 독립 게이트웨이 CLI의 scoped 복구 설정 공급

phone-gateway-main의 실제 옵션 parser와 startup 구성에 memoryReconcile을 연결했다. 새 옵션13개는 모두 없으면 비활성이고 하나라도 지정하면 전부 필요하다. 상대 경로·빈 값·제어문자·잘못된 agent/provider/key ID는 PHONE_NOT_READY로 거절한다. 기존 memory context 옵션은 유지한다.

| 옵션 | 지정할 기존 자원 |
|---|---|
| --reconcile-db | 자비스 authority DB 절대 경로 |
| --reconcile-agent | 서버에서 사용할 agent ID |
| --reconcile-policy | 현재 프로젝트/메서드 정책 파일 |
| --reconcile-provider | 대상 provider ID |
| --reconcile-signing-key | 등록된 읽기 서명 키 ID |
| --reconcile-private-key | 해당 비공개 키 파일 |
| --reconcile-spool | 원래 scoped 요청 spool |
| --reconcile-dispatch-spool | 원작업 dispatch spool |
| --reconcile-review-spool | 원작업 review spool |
| --reconcile-launcher | 기존 SB MCP 실행 프로그램 |
| --reconcile-provider-config | 고정 SB read 설정 파일 |
| --reconcile-journal-contract | scoped status v1 계약 파일 |
| --reconcile-read-contract | scoped read v5 계약 파일 |

기존 --host 127.0.0.1 --port 4176 --upstream http://127.0.0.1:4173 --static-root --env-file과 함께 사용한다. 입력은 서버 경로·등록 식별자뿐이며 cookie/session/새 권한을 CLI에서 받거나 만들지 않는다. 실제 인증은 게이트웨이 로그인 session store가 공급한다. parser의 형식 통과는 파일 내용/키 신뢰/정책 권한/운영 준비 완료를 의미하지 않으며 실제 요청 경로에서 재검사한다.

검증:
- 관련4파일 **55개 통과 / 5.37초**. 새9개는 완전/비활성/각 누락 필드·잘못된 값·startup 전달을 검사한다. startup 전달 검사는 server factory spy를 사용한다.
- 격리 TypeScript emit·변경 ESLint·diff·실행 스크립트 문법 검사 통과.
- 실제 HTTP 인수 helper가 새 CLI parser로13개 설정을 조립하여 게이트웨이 서버에 공급했다. pending/failed의 deferred/lease 해제, proved의 현재 기억 검증과 control completed, 각 exit73 후 재생·attempt1/FK0를 재검증했다. 쿠키/CSRF/Origin/정책/만료 차단도 포함한다.
- 실제 인수 서버는 임시 포트·시험 upstream을 사용한다. 고정 운영4176에서 독립 바이너리를 배포하거나 현재 서비스의 실행 인수를 바꾼 인수는 아니다. 원래 쓰기 권한·Tailnet 전달 헤더·시계는 fixture이고 로그인은 실제 테스트 게이트웨이가 발급했다.

재현은 기존 두 HTTP 인수 명령(--http)과 동일하며 helper가 이제 새 parser를 통과한다. 전체 결과는 SB SCOPED-GATEWAY-CLI-CONFIG-2026-09-09.json.

다음은 운영 환경의 실제 경로/키 등록/서비스 상태를 읽기 전용으로 대조하고, 구체적인 실행 설정과 운영 인수 절차를 준비하는 것이다. 실제 에이전트 A→B 공유, 수집/주입 지원표, 삭제/복원, 검색/GUI 등 M1–M14는 계속 남는다. 쓰기 verifier의 독립 gateway CLI 설정은 이번 옵션에 포함되지 않는다. 운영 설정/서비스/DB·push 변경은 없다. SB 제품 변경이 없어 이전 전체1,354통과/2skip을 이번55개와 합산하지 않는다.
