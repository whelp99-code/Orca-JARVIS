# 수락된 기억의 현재 읽기 연결

createMemoryScopedClient.readRememberedArtifact는 과거 수락된 scoped v4 요청을 검증하고, 현재 인증된 read v2 경로로 실제 문장/출처/SID/민감도를 대조한다. 여러 프로젝트를 허용받은 reader는 요청 범위가 포함되면 사용할 수 있다. 비동기 전송 전 요청을 복사하며 반환값에는 원문을 포함하지 않는다.

결과는 remembered_content_observed이며 outbox settled/control completed를 변경하지 않는다. 공개 read v2에는 정확한 저장 분류 증거가 없어 자동 완료 권한으로 사용할 수 없다. 최초 proof 세대와 현재 읽기 세대는 구분해야 한다.

관련 최종 53개 테스트/9.62초 통과, TypeScript 검증·격리 emit 및 변경 파일 ESLint 통과. 실제 Python 생성 레코드 fixture를 사용했다. supervised stdio MCP에서 v4 저장소 조회, MCP 프로세스 재시작 후 같은 4개 레코드 조회, 다중 프로젝트 범위 포함, provider 정책 변경과 issuer 정책 철회 거절을 검증했다. 고정 시계/격리 DB/테스트 키를 썼으며 초기 v4 쓰기 권한은 fixture callback이다.

실제 MCP에서 발견한 REQUEST_SCHEMA_UNSUPPORTED는 세컨드브레인의 기존 v4 journal 인식 경로와 함께 수정해야 한다. SB 전체 1,237개 통과/2개 건너뜀(215.74초). 운영 배포·운영 데이터 변경은 하지 않았다.

[두 리포 통합 분석과 검증 결과](../../second-brain-app/REMEMBERED-ARTIFACT-MCP-2026-09-09.md)
