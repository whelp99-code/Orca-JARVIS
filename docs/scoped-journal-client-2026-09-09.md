# 자비스 최초 세대 이전 원장 상태 소비

`createMemoryScopedJournalClient`와 `scoped-request-status-v1` 전송 프로필을 추가했다. 원래 V4 요청을 불변 복사하고 기존 production status issuer를 사용한다. 현재 정책·세션·서명 만료·삭제 fence를 전송 전과 응답 후, 반환 직전에 재검사한다. 응답의 정확한 필드·profile·request/claim digest·provider·삭제 이력을 검증한 뒤 기존 원래 수락/원장 상태 parser를 재사용한다.

결과는 `scoped_journal_status_observed`와 역사적 status뿐이다. generation/pages/완료 증거는 제공하지 않는다. 기존 read v1–v5 및 현재 artifact/settlement 경로는 유지한다. 이 결과만으로 재전송·최종 완료·실패 처분을 자동 실행하지 않는다.

실제 MCP 인수에서 `SECOND_BRAIN_SCHEMA_MISMATCH`를 발견했다. 새 프로필이 재귀 JsonValue 스키마 비교 경로에 빠져 있었으며 명시적 프로필 등록으로 수정했다. 실제 producer 스키마 허용과 required 필드 변조 거부를 회귀 검사했다. 계약 해시나 기존 계약은 완화하지 않았다.

검증:
- 관련 7파일 **56개 통과 / 23.60초**. 최초의 신규 suite 실패는 canonical codec에 포맷된 fixture JSON을 그대로 전달한 테스트 준비 오류를 수정했다.
- 격리 TypeScript emit, 변경 ESLint, diff 검사 통과.
- 새 임시 패키징 디렉터리에서 계약과 SHA sidecar 일치 확인. SHA256 `973c4ed1d26a7b258e6b35c261c074666bebd54c5de354d89fb0b085414294cf`.
- 실제 자비스 production issuer·파일 정책·supervised transport→별도 Python MCP에서 pending/failed 각각 원래 acceptance 회수. 각 MCP 재시작 후 동일 결과, provider key 철회·issuer policy 철회 거부, provider 복원 후 다시 동일 결과.
- 원래 저장은 임시 fixture authority, 읽기 세션·시간은 시험 구성이다. 운영 로그인/Tailnet·실제 A→B 사용 인수는 아니다.

재현은 SB `scripts/scoped-journal-client-acceptance.py <격리 JARVIS 빌드> pending` 및 `failed`로 수행한다(TMPDIR=/var/tmp, PYTHONPATH=SB 루트, JARVIS cwd). helper가 원장 수락 후 Node 소비자를 실행하고 각 MCP 프로세스·DB·임시 경로를 정리한다.

SB 제품은 이전 `0e3d31b` 그대로이며 이 단위는 소비자와 실사용 경로 시험 스크립트다. 이전 SB 전체 회귀는 1,354통과/2skip/290.17초(embeddings 제외)이며 이번에 다시 실행한 수치로 합산하지 않는다.

다음은 현재 reconciliation lease 아래 원래 outbox acceptance의 영속 복구 연결과 중단 인수다. 이 클라이언트만으로 자동 복구 workflow가 끝난 것은 아니다. 운영 설정/세션 공급·실제 A→B·삭제/복원·검색/GUI 등 M1–M14 전체 목표를 유지한다. Push/운영 서비스/DB 변경은 없다.
