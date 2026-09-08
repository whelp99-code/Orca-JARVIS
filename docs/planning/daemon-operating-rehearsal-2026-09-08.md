# 데몬 식별 운영 사본 인수 — 2026-09-08

목록19의 운영 전환 준비 증거. 운영 원본은 readonly로 열었고 서비스 재시작·배포·원본 migration은 수행하지 않았다.

## 배포 SQL과 운영 구조의 대조

`a3cbbbe1604798052db6051a8751f039573eb126/dist/migrations`의 57개 SQL을 메모리 DB에 적용했다.
2026-09-08T06:00:07Z의 운영 sqlite_schema와 type/name/tbl_name/sql을 정확하게 비교했다.

- 기준 객체1,281개, 운영 객체1,284개.
- 기준 객체 누락0, 정의 변경0.
- 추가: `evolution_performance_records`, 해당 기본 키 자동 인덱스,
  `evolution_performance_records_task_key_idx`. 테이블은 조회 시점0행이었다.
- 현재 src/migrations 및 Git 전체 ref의 `028_budgeted_evolution_memory.sql` 이력에서
  해당 원본을 찾지 못했다. 추가 journal과 추가 객체의 인과관계는 원본 SQL 없이 확정하지 않는다.

## 격리 사본의 forward migration

SQLite online backup으로 별도 0600 파일을 만들었다. 초기 quick_check=ok, journal58개였다.
새 코드의 migration을 사본에 적용하여058~071의14개를 추가했다.

- 사본 journal72개, 현재 운영 journal58개 모두 id/checksum/applied_at 그대로 보존.
- quick_check=ok, foreign_key_check 위반0.
- 새71개 migration 기준과 비교하여 구조 누락0, 변경0, 위 추가 객체3개 유지.
- `assertMigrationsReady()`는 통과하지만 이 검사는 예상 밖 journal을 거부하지 않는다.
  그러므로 운영 호환성 전체나 배포 승인 판정으로 사용하지 않는다.
- 첫 진단 스크립트는 migration 성공 후 잘못된 helper 이름 `assertReady()` 때문에 실패했다.
  사본을 다시 migration하지 않고 실제 `assertMigrationsReady()`와 무결성·구조 대조를 완료했다.

## 실제 built CLI 소비

사본에서 `service once`는 connected=false, processed=null, state=disconnected로 반환했다.
이어 별도 `runtime identity` CLI는 observer PID2408072와 저장 daemon PID2408053을 분리했다.
daemon build=matched, status=inactive/lease_expired였다. DB는 missing0/unexpected1/changed0의
mismatch로 표시되어 추가 기록을 숨기지 않았다. 실제 업무 실행 연결을 검증한 것은 아니다.

## 보류와 재개 조건

운영 migration/릴리스 전환은 HOLD를 유지한다. 원본 SQL의 출처·배포 이력과 추가 객체의
소유 정책을 확인하고, 실제 연결된 업무의 인수 및 운영자 지시 범위를 충족해야 한다.
추가 journal/객체가 비어 있다는 이유로 삭제하거나 migration 기록을 바꾸지 않는다.
데몬 화면은 개발 브랜치에서 연결·검증했다. 이후 파일 변경 관측, 정상 schema 기준선 판정과
전체01–25는 남는다. 메인의 기억 원장071과 통합하면서 미배포 데몬 SQL을072로 배정했다.
이 문서의 사본은 이전 데몬071 기준이며, 새 통합판 인수는 원본에서 만든 새 사본으로 진행한다.

증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의
`production-schema-vs-release57.json`, `production-migration-rehearsal.json`,
`production-copy-runtime-identity.json`. 사본 DB는 같은 비공개 캐시의
`production-migration-rehearsal.sqlite`이며 소스 저장소에 추가하지 않는다.
