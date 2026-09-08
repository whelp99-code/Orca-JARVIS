# outbox 요청 프로필 분리 — v4 등록 전 소비자 경계

2026-09-09. 기존 outbox의 원장 schema_version과 wire 요청 버전은 다르다. 같은 행 구조를 쓰면서 v4 자료를 연결할 때 일반 worker가 이를 legacy 요청으로 재구성하거나 실패 처리하지 않도록 프로필을 명시한다.

새 migration077은 request_profile(legacy/scoped-v4)을 추가한다. 기존 행·기존 enqueue의 기본값은 legacy이며 이후 프로필 수정은 trigger로 거부한다. 기존 migration SQL은 변경하지 않았다. 새 프로필별 상태 index도 추가했다.

현재 코드의 legacy worker는 dispatch claim·불확정 dispatch 복구·reconcile claim·control 결과 재조정·list에서 legacy 행만 선택한다. 직접 get/요청 재구성은 scoped-v4를 MEMORY_OUTBOX_PROFILE_UNSUPPORTED로 거부하여 기존 v2 결과로 잘못 표시하지 않는다. 기존 candidate UNIQUE와 승인/dispatch/settlement guard를 유지한다.

검증: 초기 profile+publication11통과. 확대 outbox/승인/처리/동시성/마이그레이션12파일71통과(44.38초), 타입·변경 파일 ESLint·격리 emit 통과. scoped 표시는 SQL로 만든 routing fixture이며 유효한 승인 v4 등록을 의미하지 않는다. 이 행에서 일반 runOnce는 claimed/dispatched/failed/settled0, writer 호출0, 행 불변이었다. 일반 legacy enqueue/get·프로필 변경 거부도 검증했다.

실제 독립 프로세스2개로 migration076까지의 DB에 정상 legacy outbox1개를 enqueue한 뒤077을 적용했다. 기존 열 전부 불변·queued1 보존·request_profile legacy·schema_migrations76→77·FK오류0·quick_check ok. 새 격리 build로 같은 인수를 다시 통과했다. SB scripts/outbox-profile-migration-acceptance.py <build> <JARVIS repo>로 재현한다.

이 migration은 범위 승인 소비·v4 outbox 등록 API·provider 호출을 활성화하지 않는다. scoped-v4 값을 넣는 것 자체가 권한 증거도 아니다. 수정되지 않은 과거 worker 바이너리는 이 필터를 모르므로 v4 등록 전 전체 worker release/readiness를 확인해야 한다. 운영 DB migration/서비스 재시작은 수행하지 않았다. 승인 단일 소비·outbox 원자적 확정·v4 처리/영수증과 전체 운영 인수는 계속 필요하다.
