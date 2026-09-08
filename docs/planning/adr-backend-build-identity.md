# 백엔드 빌드 산출물 식별과 실패 복구

상태: 목록19의 빌드 생산자 구현·검증. 운영 프로세스 식별 및 상태 화면 연결은 후속 범위다.

## 문제와 변경

기존 `tsc`는 삭제된 소스의 예전 JS를 dist에서 제거하지 않았다. Git HEAD만으로는 dirty
소스로 컴파일한 결과와 같은 HEAD의 원본 결과를 구분할 수도 없었다. 현재 빌드는 별도
staging에서 컴파일하고 마이그레이션·계약을 복사한 뒤 backend 소유의 src/tests/migrations/
contracts 네 디렉터리를 교체한다. dist/dashboard는 별도 빌드 소유로 보존한다.

`dist/build-metadata.json` schema1은 다음을 기록한다.

- 소스 HEAD와 dirty 여부. Git 없는 archive는 null이며 상위 저장소의 HEAD를 가져오지 않는다.
- 입력 파일 벡터의 SHA256·파일 수, Node 버전/ABI·OS·CPU·TypeScript 버전.
- backend 산출물 전체의 상대 경로·바이트·mode·SHA256 및 벡터 digest. JS 외 MJS/CJS도 포함한다.
- 실제 복사된 SQL의 ID·checksum 목록과 도메인 구분 migration digest.

입력·산출물의 내용은 manifest에 복제하지 않는다. 심볼릭 링크와 파일/바이트 상한 초과는
실패한다. 입력은 컴파일 전후 다시 검사한다. 네 디렉터리 교체 후 산출물을 다시 해시하고
manifest를 마지막에 rename한다. source_dirty=true를 배포 가능한 정본 SHA로 표시하지 않는다.

## 동시 실행과 실패

dist의 SQLite 파일에 BEGIN EXCLUSIVE를 유지한다. 경쟁 빌드는 metadata나 산출물을 건드리기
전에 BACKEND_BUILD_ACTIVE로 실패한다. OS가 프로세스 종료 시 잠금을 해제하므로 PID 파일
만료 삭제 경합이 없다. 이는 설치된 better-sqlite3 native 모듈을 빌드에도 요구한다.

잠금 획득 후 이전 manifest를 제거한다. 컴파일/입력 재검사 실패는 이전 코드를 보존한다.
교체 중 오류는 이전 디렉터리를 복원한다. metadata 삭제나 복원 자체가 실패해도 나머지
복원을 시도하며 staging의 복구본을 보존하고 recovery_root를 stderr에 남긴다.

이는 여러 디렉터리의 crash-atomic 전환이 아니다. SIGKILL/전원 중단 시 mixed output과
staging이 남을 수 있으므로 manifest 없는 dist를 성공한 빌드로 취급할 수 없다. 실행 중인
운영 dist를 이 명령으로 교체하지 않는다. immutable release 전환/복구는 기존 운영 경계를 따른다.

## 검증

증거 루트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

- `backend-build.test.mjs`는 실제 TypeScript 자식 컴파일로 실행 파일 회수, 삭제 소스의 잔여
  제거, 컴파일 실패, 입력 변경, dirty HEAD, 경쟁 빌드, lock owner SIGKILL, 교체 실패와
  rollback 실패·metadata 정리 실패를 검사한다. 최종 관련10개 pass.
- 실제 프로젝트 `npm run build:backend`, lint, typecheck, CLI smoke,
  고정시각 pre-GJC acceptance 각각 exit0. 해당 로그는 `build-identity-*.log`다.
- 현재 전체 변경을 읽은 독립 fresh review는 ship/필수 결함0건이었다. 위10개와 실제 빌드
  검증은 이번 단위 결과이며 이전010281c 전체 verify를 현재 변경의 전체 통과로 표시하지 않는다.
- `build-identity-live.mjs/json`: 별도 해시 계산으로 산출물1,044개/6,002,823bytes와 manifest
  일치. 새 AuthorityDb에 적용한 SQL70개와 ID/checksum·vector digest 일치.
  dashboard4개 전체 bytes/mode/digest 보존, 시험용 stale JS 제거, staging잔여0,
  격리 SQLite 디렉터리 제거 확인. 운영 DB에는 접근하지 않았다.

입력 digest는 lockfile·설정·소스 파일을 나타내며 node_modules 전체 attestation이나
재현 가능한 빌드 증명이 아니다. 빌드 도중 입력의 일시적 변경과 원상복귀까지 탐지하는
snapshot도 아니다. 실행 중 프로세스, 디스크의 현재 산출물, 실제 DB schema, 배포 release의
네 상태를 연결할 후속 reader에서 이 제한과 unknown 상태를 명시해야 한다.

## 남은 인수 범위

운영 프로세스 시작 시 산출물 식별, 현재 디스크와 시작 당시 상태 구분, 읽기 전용 DB schema
대조, CLI/API/대시보드와 배포 전환 인수는 미완료다. 이 producer를 추가한 것만으로 목록19나
전체01–25 완료를 선언하지 않는다. 기존 manifest 없는 release는 unknown으로 읽어야 하며
현재 checkout의 HEAD를 해당 프로세스의 SHA로 대신 표시해서는 안 된다.
