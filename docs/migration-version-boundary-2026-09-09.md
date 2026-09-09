# 알 수 없는 DB 마이그레이션 이력 차단

MigrationStore가 자신의 SQL 목록에 없는 적용 이력을 무시하여, 오래된 실행물이 더 새로운 DB를 준비 완료로 판정할 수 있었다. assertReady는 알려진 이력만 허용하며 migrate도 forward SQL이나 Task30 복구를 실행하기 전에 알 수 없는 이력을 MIGRATION_VERSION_UNSUPPORTED로 거절한다.

명시적으로 구현된 rejected Task30 복구 대상 ID는 migrate 진입에서만 기존 복구기로 보낸다. 기존 checksum/prefix/layout/data 검사와 키 보존은 유지한다. readiness는 해당 복구를 허가하지 않는다. 기존 migration SQL은 변경하지 않았다.

검증: migration-version-boundary 1개, 기존 migrations 7개, memory-effect-migrations 8개, 총16개 통과/16.53초. 새 검사는 최신 DB에서 로컬 SQL 목록을 줄여 readiness와 migrate 모두 거절함을 확인한다. 다른 pending SQL이 있어도 실행되지 않고 total_changes/원래 행/마이그레이션 행 수가 보존된다. 기존 rejected prefix1–5 복구와 checksum/layout/data 거부도 통과한다. 격리 TypeScript emit, 변경 ESLint 통과.

운영 사본에서는 기존58개 이력 중 028_budgeted_evolution_memory.sql이 현재 배포 SQL 목록에 없어 새 검사가 전환을 거절했다. 이 미확인 이력은 docs/planning/daemon-operating-rehearsal-2026-09-08.md에도 기록돼 있다. 거절 후 사본 전체 행은 불변이다. 기존 운영 실행물 자체는 전환된 사본을 여전히 ready로 받아들이므로 구·신 실행물 혼합 운용 및 단순 symlink rollback은 보류한다.

보류 해제에는 미확인 SQL 원문·배포 경위·객체 소유권을 확인하고 명시적인 호환/전환 정책을 검증해야 한다. 이력을 삭제하거나 ID만 allowlist에 추가하지 않는다. 새 개발 검사가 기존 설치 바이너리를 소급 수정하는 것은 아니다. 운영 DB/서비스/릴리스 변경 없음.
