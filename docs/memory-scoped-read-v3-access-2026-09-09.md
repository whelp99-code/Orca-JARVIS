# scoped read v3의 정확한 분류 대조

createProductionScopedMemory의 명시적 profile 옵션으로 scoped-record-read-v3를 선택할 수 있다. 기본은 v2다. 새 계약의 sb_read_page는 기존 요청/claim/세대/삭제 fence에 묶인 전체 page_access를 반환한다. 최대 64개 출처의 분류 형식·정렬·해시·현재 scope를 확인한다.

readRememberedArtifact가 원래 쓰기 요청의 출처 식별자 및 정확한 owner/projects/policy를 확인하면 remembered_artifact_observed를 반환한다. v1/v2의 remembered_content_observed와 구분하며 자동 settled/control completed를 변경하지 않는다. 여러 프로젝트를 허용받은 reader도 원래 요청과 다른 저장 분류를 같은 결과로 인정하지 않는다.

v3 계약은 별도 checksum으로 고정하고 packaging 목록에 추가했다. frozen schema 비교 분기 누락은 실제 MCP handshake 실패와 단위 검사 1 실패/4 통과로 재현한 후 수정했다. 최종 관련 74개/18.16초, TypeScript 격리 emit·변경 파일 ESLint 통과. SB 전체 1,241개/2 건너뜀/224.67초. 새 provider와 자비스 소비자가 함께 필요하며 자동 fallback은 하지 않는다.

실제 production 구성 함수·파일 정책·supervised stdio MCP에서 v4 기억의 분류와 레코드 4개를 읽고, 재시작 후 재조회·다중 프로젝트 권한·provider/issuer 정책 철회를 검증했다. 별도 v2 실행은 기존 형식으로 통과했다. 키·세션·DB·시계는 fixture이며 초기 내부 쓰기 authority callback=True다. 운영 권한이나 운영 배포 인수 완료로 해석하지 않는다.

[통합 보고서 및 실제 프로세스 결과](../../second-brain-app/SCOPED-READ-V3-ACCESS-2026-09-09.md)
