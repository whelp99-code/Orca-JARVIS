# 백엔드 빌드 산출물 식별과 실패 복구

상태: 목록19의 빌드 생산자와 현황판 서버 식별/API/화면 구현·격리 인수·독립 리뷰 완료.
authority daemon의 첫 cycle 관측 저장·진단 CLI는 [후속 단위](adr-daemon-runtime-identity.md)에서 구현한다.
대시보드 daemon 표시와 실제 운영 전환 인수는 후속 범위다.

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

현황판 서버의 초기화 관측과 API/대시보드 표시는 아래 후속 단위에서 구현했다. authority
daemon의 별도 release 식별, CLI 연결, 현재 디스크 재관측, 승인된 schema 기준선과 실제 구조
대조, 실제 운영 release 전환 인수는 미완료다. 목록19와 전체01–25 완료를 선언하지 않는다.
기존 manifest 없는 release는 unknown으로 읽고 현재 checkout의 HEAD로 대체하지 않는다.

## 후속 상태 조회 계약 — 구현 결정

DashboardReadModel 생성 시 모듈 경로에 대응하는 backend root에서 manifest를 검증하고
현재 파일 벡터를 대조한 관측을 보존한다. 이후 GET에서 checkout이나 디스크를 재해석해
시작 당시 SHA를 바꾸지 않는다. 이 관측은 로드된 모든 모듈의 메모리 attestation이 아니다.
표시는 `서버 초기화 시 파일 대조`이며 확인 시각·PID·프로세스 시작 시각을 함께 제공한다.

overview 응답에 선택적 runtime 필드를 추가한다. 구버전 응답은 화면에서 식별 정보 없음으로
표시한다. manifest 누락/파싱 실패/읽기 실패/파일 불일치와 Node toolchain 불일치를 구분한다.
요청 경로에는 manifest의 파일명·임의 문자열·로컬 절대경로를 노출하지 않는다.

DB는 GET의 읽기 snapshot에서 적용 migration ID/checksum과 기대 벡터를 대조하여 누락·추가·
변경 개수를 보고한다. 별도로 sqlite_schema의 객체 수와 digest를 관측한다. migration 일치는
실제 테이블 구조의 정상 판정이 아니므로 UI에서 `마이그레이션 기록`으로 명명하고 schema hash를
구별한다. 조회는 migration 실행·초기화·파일 쓰기를 수행하지 않는다.

운영 release 적용 승인이나 frontend/staticRoot의 빌드 식별은 위 상태로 추정하지 않는다.
시작 관측 고정, manifest 없는 구버전, 잘못된 vector, 추가/변경/missing journal, 실제 schema
변경, 재개방 및 조회 쓰기0을 검증하고 실제 built HTTP/Chromium으로 표시를 확인한다.

## 후속 구현·검증 결과

- src/runtime-identity는 모듈 기준 root의 manifest를 엄격히 검사하고 file vector를 대조한다.
  이후 DB handle 재개방에는 새 연결을 사용하되 build 관측은 보존한다. 반환 객체 변경으로
  다음 조회의 시작 관측을 변조할 수 없다. DB 원문/파일 목록/로컬 경로는 응답에 포함하지 않는다.
- 원장 테이블을 재생성하여 같은 migration ID를 중복 저장한 반례는1fail/15pass였다.
  중복 ID는 unavailable로 판정하도록 수정했다. lint의 제어문자 정규식 오류1개도 수정했다.
- 최종 backend6파일33개/15.57초, dashboard33파일190개/30.19초 pass.
  full build, backend 재빌드, typecheck, lint, CLI smoke, 고정시각 acceptance exit0.
  해당 로그는 증거 루트의 runtime-identity-*.log이며 전체 verify 결과는 아니다.
- 실제 compiled HTTP/Chromium은 127.0.0.1:37809/overview에서 검사했다. 서버 초기화31.762ms
  (단일 표본, 기존 대비 성능 향상 지표 아님), manifest와1,049파일·70migration 일치.
  PID2076416·소스ae23366/dirty=true의 시작 관측을 확인했다.
- 시험 DB에 추가 migration1개→API mismatch/unexpected1→SSE 후 화면 `적용 차이 있음` 표시.
  별도 테이블 생성으로 schema 객체1,359→1,360과 digest 변화, migration 기록은 matched를
  확인했다. 원상복귀 후 schema hash와 시작 build 관측 동일, 각 GET의 total_changes 증가0.
- Playwright Chromium 1440×1000 및390×844에서 정보 펼치기·SHA·dirty·DB 표시를 확인했다.
  두 화면 가로 넘침0, 해당 component axe serious/critical0, page error/console warning/error0.
  스크린샷을 직접 확인했다. Browser plugin not available로 설치된 Playwright를 사용했다.
- 최초 browser probe는 axe가 명시 newContext를 요구해 실패했다. probe 수정 후 최종 exit0,
  운영 서비스가 아닌 격리 서버/DB로 수행했고 임시 디렉터리 삭제를 확인했다.
  스크립트·결과·화면은 runtime-identity-live.mjs/json, runtime-identity-{1440,390,db-mismatch}.png다.

화면의 파일 대조는 초기화 시 디스크 관측이며 이미 로드된 모듈의 전수 메모리 검증이 아니다.
DB 구조 해시는 관측값이며 정상 baseline 판정이 아니다. UI의 서술도 이 경계를 유지한다.

## 독립 리뷰 후 API 응답 경계 보강

첫 fresh reviewer는 overview의 선택 runtime 필드 검증 누락을 지적했다. 기존 isOverview를
통과한 runtime:{}가 화면에서 build.status 접근 오류를 일으킬 수 있었다. API 클라이언트에
구조·enum·nullable·safe count·정규 UTC시각·SHA 검증을 추가했다. 구버전의 필드 없음은
허용하되 malformed runtime은 기존 VALIDATION_ERROR 경로로 거부한다. 신규14개는 수정 전
14fail/기존4pass, 수정 후 전체 dashboard33파일205개/34.75초 pass다.

새 full build/typecheck/lint exit0. backend33개 검증 이후 backend 소스 변경은 없다.
실제 Chromium 재인수 127.0.0.1:41041은 기존 desktop/mobile·DB변경 검증에 malformed 응답
주입→오류 화면→정상 응답 복구를 추가했다. console/pageerrors0·component axe serious/critical0,
가로넘침0·GET쓰기0·시험디렉터리삭제를 확인했다. runtime-identity-live.json과 화면은 이 최종
결과로 갱신됐으며 PID2130213/초기화31.897ms다. 앞선 기록은 이전 실행 관측이다.

중간 probe의 route.fetch 이후 reload 경합은 Route is already handled 오류였다. 고정 정상
응답을 준비한 fulfill과 unrouteAll(wait)로 시험 스크립트를 수정했다. 예외 종료 잔여 시험
디렉터리1개는 /proc 열린FD사용자0 확인 후 제거했다. 재실행 제품 코드를 바꾸지 않았다.
fresh 재검토 요청: gpt-5.6-terra/high, `/root/review_runtime_identity_final`.
최종 verdict ship/필수 수정0건. 실제 모델/effort는 native 도구에 노출되지 않았으며 리뷰어의
GPT-6 표기는 자기 보고로 구분한다. CodeRabbit 결과는 없고 native 독립 정적 리뷰 결과다.
