# 공통 기억 기본 조회 서명 연결

2026-09-08. Second Brain 인계의 삭제 이후 저장·완료 확인·재사용 경로를 보강했다. 운영 환경변수/키/DB/release를 변경하거나 서비스를 재시작하지 않았다.

기본 CLI outbox와 dashboard가 `JARVIS_MEMORY_PROVIDER_INSTANCE_ID`, `JARVIS_MEMORY_SIGNING_KEY_ID`, `JARVIS_MEMORY_PRIVATE_KEY_PATH`를 함께 읽는다. 기존 owner Ed25519 등록 키의 fingerprint·상태·기간을 매 조회 검사하고 해당 DB의 현재 `memory_tombstone_chain` high-water로 60초 이하 read fence를 서명한다. 키 등록·생성·provider 원장 복사는 하지 않는다. 키 파일은 실행 사용자 소유 PKCS8 PEM 일반 파일, group/other 접근 없음, 단일 hard link, 16KiB 이하를 요구한다.

세 변수가 모두 없으면 기존 초기 무서명 경로를 유지한다. 부분 설정/잘못된 파일은 `MEMORY_READ_FENCE_CONFIG_INVALID`, 조회 시 키 철회/만료/불일치는 `MEMORY_READ_FENCE_KEY_UNAVAILABLE`, DB 오류는 `MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE`다. 후자의 두 오류는 adapter invalid로 반환하며 무서명 fallback을 전송하지 않는다. 명시 callback 주입은 유지한다. dashboard가 다른 DB에 outbox를 구성하면 그 DB의 키/원장을 사용한다.

기존 effect service의 서명 함수를 공유하고 frozen V1/V2 계약은 변경하지 않았다. SB는 마지막 record 삭제 후 `sources: []`를 기존 공개 scalar로 정규화했다. 외부 OSS 코드/패키지는 추가하지 않았다.

검증: 관련 Vitest 149 passed / 26 files (집중 20개 포함), 변경 ESLint·최종 backend build 통과. Python 계약·삭제/복원 18 passed, Ruff 통과. 독립 검토의 DB별 연결·ID 호환 지적 수정 후 추가 actionable 없음.

격리 실제 MCP와 CLI API: 삭제 proved/sequence 1 → 무서명·이전 fence 거부 → 삭제 record 0 → 민감 record 64개 새 저장 → outbox settled/control completed → 두 클라이언트 동일 record 회수. replay 재실행 idle, 추가 dispatch 0, review 원문 잔여 0, cleanup/control 오류 없음. 실제 자비스 삭제 UI 전체나 Codex/Claude 앱 자동 수집·주입 인수는 아니다.

상세 구성·재현·운영 미완료 조건은 [SB 검증 보고서](../../second-brain-app/MEMORY-READ-FENCE-INTEGRATION-2026-09-08.md), 전체 OSS 선택 흡수 방향은 [인계 원문](second-brain-oss-absorption-handoff-2026-09-07.md)을 따른다. 다음은 실제 후보/publication/UI 흐름, 운영 구성·전환, 앱별 접근/수집/주입과 범위, 일반 LF/V2 정정이다.
