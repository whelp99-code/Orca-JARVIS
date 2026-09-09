# 세컨드브레인의 인증된 HTTPS 검증 호출 연결

검증 endpoint의 current_scoped_dispatch 응답 키를 canonical 순서로 반환하도록 조정했다. 필드와 인증/세션/정책 검사는 유지한다. SB의 strict JSON 파서와 실제 HTTPS 호출을 연결하기 위한 직렬화 변경이다.

SB create_scoped_provider_https는 서버 지정 비공개 설정의 origin/cookie_id/csrf_token/선택적 ca_file을 매 호출 읽는 별도 Python 프로세스를 실행한다. 기존 bounded process가 DNS/TLS/HTTP를 포함한 전체 실행을20초로 제한한다. 인증서 검증을 활성화하고 리디렉션을 따르지 않으며 Tailscale-User-Login 헤더를 직접 만들지 않는다. 현재 로그인 세션 판정은 이 게이트웨이가 수행한다.

검증:
- JARVIS 실제 gateway HTTP 회귀1개 통과(3.99초), 격리 TypeScript emit 및 변경 ESLint 통과.
- SB 관련76개 통과(14.14초), Ruff 및 새 모듈 정적검사 통과.
- 실제 TLS 앞단→게이트웨이→별도 Python 수락/실행 인수에서 정상proved/검증5회, 수락 중 철회denied/2회/수락 원장 없음, 실행 전 철회failed/3회/활성 세대 없음, 실행 전 로그인 만료failed/3회/활성 세대 없음. 원래 dispatch attempt1/FK0 유지.
- 첫 인수의 테스트 디렉터리 정리가 읽기 전용 세대 때문에 실패했다. 테스트 소유 디렉터리에 기존 정리 패턴을 적용하고 전체 인수를 재실행해 exit0을 확인했다.

TLS 인증서와 gateway session 발행은 실제 라이브러리 경로이며 로그인된 세션은 게이트웨이 메모리에 유지된다. 신뢰된 전달자의 Tailscale 헤더·시간·policy/dispatch 및 TLS CA는 임시 fixture다. 운영 Tailnet 배포, 공개 MCP scoped 쓰기, 실제 사용자 클라이언트A→B 인수를 완료했다고 보고하지 않는다.

세션/권한 판정 JSON 복사는 계속 보류한다. 비공개 쿠키 저장은 판정 복사와 다르다: 매 호출 gateway가 원래 session의 현재 상태를 검사하므로 정책 철회와 로그인 만료가 차단된다. 다만 이 bearer 자격증명의 운영 공급/회전 및 서버 실행 설정은 후속 연결 대상이다. 기존 서비스/운영 설정/DB/migration은 변경하지 않았고 push/배포하지 않았다.

전체 M1–M14 목표는 유지한다. SB 상세 결과는 ../second-brain-app/SCOPED-PROVIDER-HTTPS-2026-09-09.md 및 .json을 참조한다.
