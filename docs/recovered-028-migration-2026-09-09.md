# 배포 원본 028 마이그레이션 복원

운영 schema_migrations에만 남아 있던 028_budgeted_evolution_memory.sql 원본을 과거 control-center 릴리스3곳의 dist/migrations에서 찾았다. Git 전체 ref의 같은 경로 검색 결과는 없었지만, 배포 실행물에는 있었다.

- 릴리스: 57dec90f40f9f280eff88700106aed433518e265, 6078b6d5f669cadcd7a451c9a219744cd8f0b205, 9e35736be7315c4a66808ea03bcbbb68931a8c3b.
- 각 파일502bytes, SHA-256 `55faa41aa1c3c0b2c78ebfa4f59cd9daf6e4793deac91f39bfb3ea7e00955386`.
- 운영 journal의 같은 ID/checksum 일치, 적용 시각2026-08-21T14:45:52.570Z.
- SQL은 evolution_performance_records와 task_key 인덱스를 IF NOT EXISTS로 생성한다. 운영 같은 이름의 테이블은 이번 조회에서0행이다.

원본 bytes를 migrations/028_budgeted_evolution_memory.sql로 그대로 복원했다. 기존 SQL bytes/운영 이력은 수정하지 않고 미확인 ID 허용 예외도 추가하지 않았다. a2e59eb의 unknown history 거부는 유지한다. 이 변경은 과거 DB 구조를 재현하는 자산 복원이며 별도 evolution 기능을 활성화하지 않는다. 릴리스 디렉터리3개와 journal 일치는 바이트 출처의 근거이지 당시 작업자·승인·배포 경위 전체의 증거는 아니다.

검증: 관련 migrations7 + memory-effect-migrations8 + version-boundary 최종2, 고유17개 통과. 원본 해시 고정, 값이 있는 performance row의 migration replay 보존 및 successes<=runs 제약 유지 검사 추가. 격리 tsc emit/변경 ESLint 통과.

실제 운영 DB online backup의 새 코드 migrate/assertMigrationsReady/replay 통과. 이력58→81, 기존58개 id/checksum/applied_at 보존, 업무 테이블212개 원래 값 보존(그중17개 비어 있지 않음), FK0/integrity ok/replay변경0. 운영 memory_candidates/outbox/control_command_requests/correction_requests는0행이므로 이 사본 시험을 실제 기억 요청 수명주기 인수로 확대하지 않는다.

운영 source는 mode=ro/query_only, 변경은 삭제되는 임시 사본에만 적용. 운영 서비스/DB/설정 변경 없음. 미확인 SQL 부재라는 차단은 해소됐지만 구 실행물의 미래 DB 수락 문제, exact vector 기반 rollout/rollback, 실제 세션·A→B 인수는 남는다.
