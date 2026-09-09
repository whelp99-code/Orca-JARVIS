# 쓰기 검증기의 DB 버전 검사 연결

일반 CLI는 assertMigrationsReady를 호출하지만 phone gateway의 provider verifier 직접 경로는 이 검사를 거치지 않았다. 기존 DB만 연다는 조건으로는 미적용·변경·알 수 없는 이력이 있는 DB를 충분히 거절할 수 없다.

openPhoneMemoryProviderCli는 연결을 연 뒤 기존 assertMigrationsReady를 기다리고, 실패하면 연결을 닫는다. startPhoneGatewayCli와 해당 open 함수는 이제 Promise를 반환한다. 모든 저장소 내 호출과 실제 인수 스크립트는 await하도록 변경했다. 서버 포트는 DB 검사가 통과한 후에만 연다. createPhoneMemoryProviderVerifier 역시 매 호출 기존 DB 검사를 기다리고, HTTP handler는 결과를 await한 후 원래 세션을 다시 검사한다. initialize/migrate나 권한 발급은 수행하지 않는다.

관련5파일67개 통과/9.72초. 시작 시 future/pending/checksum 거절·포트 생성0·소유 연결 정리, 실제 HTTP 사용 도중 unknown 이력 추가→403·DB 변경0·시험 이력 복원 후200을 확인했다. 기존 로그인·CSRF·현재 정책·세션 만료 및 context/reconcile 시작 검사도 통과했다. 격리 emit/변경 ESLint 통과.

실제 CLI 설정→TLS gateway→별도 MCP→SB CLI의4시나리오 통과: 정상proved/HTTPS5회, 수락 중 철회 미수락/2회, 실행 전 철회·만료 failed·활성세대 없음/각3회. 각 attempt1/FK0. 세션은 실제 임시 서버 발급, 원작업·시계·CA·전달자 identity는 fixture다.

운영 사본에서도 최신 migration 검사기에 이전 설치 SQL 목록을 지정하면 MIGRATION_VERSION_UNSUPPORTED로 거절한다. 이전 설치 바이너리 자체가 수정된 것은 아니다. 실행 중 DB upgrade와 요청의 모든 경합을 검증하거나 혼합 버전 운영을 허용한 결과로 확대하지 않는다. 실제 배포에는 기존 exact vector/서비스 교체/rollback 조건과 실제 A→B 인수가 필요하다. 운영 DB·설정·서비스 변경 없음.
