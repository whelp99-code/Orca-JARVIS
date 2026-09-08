# 명시적 공통 기억 조회와 정책 결합

상태: 구현 및 격리 CLI/MCP 인수. 모델 세션 자동 전달·운영 적용·B5 전체 완료는 아니다.

`memory context <query> --db <authority.db> [--limit 8] [--max_bytes 16384]`를 추가했다.
기존 read adapter와 reference-only 준비 모듈을 연결하여 출처·record digest·세대를 보존한
본문 JSON을 반환한다. 전체 stdout의 version/메타데이터/개행까지 예산에 포함한다.
기존 owner 읽기이며 프로젝트 권한을 새로 발급하지 않는다.

[ADR](planning/adr-memory-reference-read.md)에 따라 웹의 suppression 판정을 재사용하고
provider 전후 상태, 로컬 privacy revision, 최종 key 상태·만료와 본문 만료를 검사한다.
새 migration 070의 변경 계수는 SQLite REPLACE가 같은 개수의 행을 교체하는 경우도 감지한다.
projection key는 기존 authority DB 옆의 private `memory-projection.key`를 읽기만 하며 없으면
고정 오류로 거부한다. 읽기 서명은 기존 JARVIS_MEMORY_PROVIDER_INSTANCE_ID,
JARVIS_MEMORY_SIGNING_KEY_ID, JARVIS_MEMORY_PRIVATE_KEY_PATH 구성과 등록 키를 사용한다.
독립 CLI provider 경로는 JARVIS_SECOND_BRAIN_LAUNCHER / JARVIS_SECOND_BRAIN_CONFIG로
명시할 수 있다. API의 명시적 transport_options가 환경보다 우선한다.

운영 DB migration은 수행하지 않았다. 새 코드 적용 시 기존 migration 절차로 070까지 갖춘
DB가 필요하며, 누락 상태를 읽기 우회나 새 키 자동 생성으로 정상 처리하지 않는다.
owned transport는 성공 결과 준비 전에 한 번 정리한다. 주입된 transport는 호출자 소유다.
DB read transaction은 RPC 동안 유지하지 않는다. 내부 DB/키/transport 오류는 원문 없는
고정 코드로 반환한다. 같은 OS 사용자에게 제공되는 CLI 원문은 프로젝트 간 보안 격리나
모델 수신 영수증이 아니다.

상세 수정 목록, 최종 테스트 수, 실제 CLI 증거, 독립 리뷰 지적과 판정, 보류/후속 완료 조건은
[세컨드브레인 통합 보고서](../../second-brain-app/MEMORY-REFERENCE-READ-2026-09-08.md)에 기록한다.
새 운영 서비스·기억 원문 DB·승인 체계·frozen MCP 계약 변경은 없다.
