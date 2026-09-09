# 현재 게이트웨이 세션을 사용한 scoped provider 검증

기존 인증 세션은 PhoneGatewaySessionStore의 메모리에 있으므로 세션 JSON을 복사해 단발 검증 프로세스에 넣는 방식은 현재 철회를 반영하지 못한다. 그런 운영 구성은 보류하고 기존 로그인/Tailnet 소유자·Origin·cookie·CSRF 경계를 재사용한다.

createPhoneGatewayServer의 명시적 memoryProviderVerifier 옵션과 POST /api/v1/memory/provider/verify 경로를 추가했다. 옵션은 서버 소유 AuthorityDb·policy/spool/roots/provider·agent이며, 인증 세션은 요청의 cookie를 현재 store와 대조하는 기존 createPhoneMemorySessionSource에서 공급한다. 요청 writer 라벨을 인증 신원으로 사용하지 않는다. 이 옵션이 없으면 인증된 요청에도 503이다. 기존 CLI에 자동 활성화하거나 운영 설정을 추가하지 않았다.

본문은 최대32KiB의 canonical scoped V4 요청이며 기존 codec으로 검증한다. 현재 생산용 verifier가 원래 dispatch·private spool·현재 쓰기 정책/철회·동일 세션을 재검사한다. 반환은 current_scoped_dispatch 판정이다. 요청을 수락하거나 재전송하지 않고 로그인도 연장하지 않는다. DB 수명은 서버를 구성한 호출자가 소유한다. 기존 memory context capabilities의 writes_supported:false는 유지한다.

검증은 실제 loopback HTTP 서버, 임시 AuthorityDb, 실제 gateway session 발행/cookie·CSRF를 사용했다. 신뢰된 Tailscale 전달 헤더와 시간/정책·원래 dispatch는 테스트 환경이다. 운영 Tailnet 배포를 검증한 것은 아니다.

- 정상200; cookie 없음401; 잘못된 CSRF403; 같은 owner의 새 로그인 세션403; 변조 writer400; 현재 policy 철회403; 원래 세션 만료401.
- 성공 검증 시각을 최초 로그인보다10ms 진행시킨 뒤 최초 idle 만료+5ms에401임을 확인하여 세션을 연장하지 않음을 검증했다.
- 검증 전후 total_changes 동일, outbox dispatching 유지, FK 오류0; upstream proxy로 검증을 보내지 않으며 감사 로그에 cookie/원래 request_id 없음.
- 게이트웨이/세션6파일61개 통과(7.14초), provider 포함3파일12개 통과(14.31초); 새 HTTP 테스트1개 중복이므로 고유72개다. 최종 만료 경계 보강 후 같은 HTTP 테스트1개 재검사 통과(4.53초, 중복).
- TypeScript 격리 emit 및 변경 ESLint 통과. 운영 dist에 emit하지 않았다.

현재 완료 범위는 프로그램으로 설정할 수 있는 인증된 검증 endpoint다. 서버 실행 옵션/CLI의 운영 구성, SB 측 인증 HTTP 호출 연결, 공개 scoped MCP 쓰기, 실제 A 저장→B 새 세션 조회는 아직 미완료다. 게이트웨이 외 에이전트의 세션 공급도 기존 인증 경계와 별도로 대조해야 하며 전체 M1–M14 목표는 유지한다. 운영 DB/서비스/설정/migration 변경이나 push/배포는 수행하지 않았다.
