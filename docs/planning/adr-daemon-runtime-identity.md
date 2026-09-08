# Lease와 프로세스 기동에 묶인 데몬 빌드 관측

목록19 후속 개발 단위. 대상은 GJC service의 첫 실행 관측 저장, 상태 조회 및 진단 CLI다.
대시보드의 daemon 표시를 기존 overview에 연결했다. 현재 디스크 재관측, 정상 schema 기준선 비교,
운영 전환 인수는 후속이다.
전체01–25 개발 목표를 이 단위로 축소하지 않는다.

## 구현 계약

- `072_daemon_runtime_identity.sql`은 singleton 관측 테이블을 추가한다. 이전 SQL bytes는 유지한다.
- `GjcRuntimeService`는 실제 lease를 획득한 첫 cycle에서 모듈 경로 기준 process/build를 관측한다.
  `service.status`의 객체 생성이나 경쟁자의 lease 거부는 관측을 게시하지 않는다.
- 처음 게시한 transaction이 성공한 snapshot은 서비스 객체 안에 고정하고 owner/fence가 바뀔 때 다시 게시한다. 같은 lease의
  반복 cycle은 저장된 snapshot을 다시 쓰지 않는다. 반환 객체는 strict schema로 새로 파싱한다.
- 처음 게시하기 전 lease 만료·fence 교체·heartbeat rollback이 발생하면 관측을 캐시하지 않는다.
  다음 획득에서 다시 관측한다. 게시 이후 supervisor/업무 처리 실패는 이미 게시된 관측을 지우지 않는다.
- lease heartbeat, snapshot 게시, runtime heartbeat는 같은 immediate transaction이다.
  동기 파일 읽기의 실제 경과 시간을 cycle 시각에 더해 capture 중 lease가 만료되면 거부한다.
- `PERSONAL_OS_CONTROL_CHANNEL`의 staged-execstart rehearsal은 GJC cycle을 호출하지 않는다.
  이 경로는 새 identity/lease/runtime status를 게시하지 않는다.
- process identity는 Linux boot ID, PID namespace, PID, start token을 결합한다. observer의
  `/proc/self/stat` PID와 자체 PID를 먼저 확인하고 namespace/두 stat 읽기의 token 일치를 확인한다.
  `Z`, `X`, `PF_EXITING`은 실행 중으로 판정하지 않는다. 다른 namespace/관측 불가는 unknown이다.
  종료 상태도 target namespace와 두 stat의 동일 기동을 확인한 후에만 해당 데몬에 귀속한다.
  종료 중 namespace를 읽을 수 없으면 unknown으로 남기며 active로 승격하지 않는다.
- snapshot JSON은 8KiB 이하이며 경로·파일 내용·명령 인자·환경 변수를 저장하지 않는다.
  조회는 한 SQLite snapshot에서 제한된 필드만 읽고 원문 lease owner를 반환하지 않는다.

| 상태 | 의미 |
|---|---|
| active | exact owner/fence의 유효 lease와 같은 non-exiting 프로세스 기동을 관측 |
| inactive | 저장된 실행의 lease가 사라지거나 release/expire됨 |
| stale | 현재 lease가 다른 실행이거나 PID 소멸·종료·boot/start token 모순 |
| unknown | 기록 없음·형식 오류·시계 모순·namespace/프로세스/DB 관측 불가 |

active는 업무 준비·진행·정상 schema·배포 승인 판정이 아니다. build의 matched/missing 등은
process/lease 상태와 별개다. build.checked_at은 첫 cycle의 디스크 관측 시각이며, 프로세스 시작 시각과
다를 수 있다. 이미 로드된 전체 모듈의 메모리 attestation이나 이후 디스크 변화 감시는 아니다.

## CLI

`node dist/src/cli.js runtime identity --db <DB>`는 다음 두 출처를 분리한다.

- observer: 이번 CLI 프로세스의 빌드/Node ABI와 지금 읽은 DB migration 기록·실제 schema hash.
- daemon: DB에 보존된 GJC 실행의 process/build snapshot과 이번 lease/process 관측 판정.

이 명령은 AuthorityDb를 만들기 전에 기존 DB를 readonly/fileMustExist로 연다. 없는 DB를 생성하거나
migration을 실행하지 않는다. 오래된 schema도 진단 가능하며 실패 시 unavailable을 반환한다.
`service status`와 `gjc status`는 `daemon_identity` 필드를 추가하고 이전 health 필드를 유지한다.

## 현황판

- overview의 기존 읽기 transaction에서 `daemon_identity`를 관측한다. 조회 중 DB 변경 검사를
  유지하고 신규 쓰기·캐시·polling 경로를 만들지 않는다.
- 현황판 서버의 runtime과 작업 데몬의 저장된 process/build를 별도 접이식 영역으로 표시한다.
  판정 시각·근거·lease·첫 게시 빌드 관측을 함께 표시하며 업무 준비 상태로 해석하지 않는다.
- 기존 서버가 필드를 생략하면 식별 정보 미제공을 표시한다. 잘못된 응답은 API 경계에서 거부하며,
  active는 유효한 관측 시각·snapshot/incarnation·lease와 일관된 heartbeat/만료가 있어야 한다.
  missing/invalid/unavailable은 이전 상세를 포함할 수 없으며 inactive/stale도 백엔드 상태별
  snapshot·lease·시각 조건을 검증한다. 모순된 응답8개는 보강 전 통과해 회귀 검사에 실패했다.
- 상태 갱신은 기존 overview/SSE 흐름을 사용한다. 종료 후에는 이전 실행 관측으로 바뀌고,
  저장된 관측이 없거나 형식이 깨지면 이전 PID/빌드 상세를 남기지 않는다.
- DB 쓰기 없이 lease만 만료되는 경우에도 기존 단일 freshness 타이머가 overview를 다시 읽는다.
  서버의 관측→만료 간격을 사용해 브라우저 시계 차이를 피하고, 갱신·중지 시 이전 타이머를 취소한다.
- 별도 Node 데몬과 실제 Chromium으로 펼치기→강제 종료→lease 만료→손상→구버전 응답을
  검증했다. HTTP 조회 total_changes 차이0, 1440px/390px 가로 넘침0, axe serious/critical0,
  console/page 오류0. 증거는 `daemon-dashboard-live.json` 및 같은 이름의 이미지들이다.
  운영 서비스·DB는 이 격리 검증의 대상이 아니다.

## 검증과 증거

증거 루트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

- 첫 회귀 묶음5파일39개 pass: 원자 게시, 경쟁 소유권, release/reacquire, stale/unknown,
  출처 고정, PID/boot/namespace·종료·fence 교체, 읽기 total_changes 불변.
- 실제 built CLI 초기3fail은 normalizeCliValues의 undefined key들을 입력 옵션으로 잘못 검사한
  결함이었다. 원래 parsed.values의 제공된 키만 검사하도록 수정했고 실제 CLI3개 재검증 pass.
- 최신 migration/identity 묶음5파일36개 pass. 파일 해시 중60초 lease 만료 시 게시0을 포함한다.
- 실제 별도 Node 프로세스의 첫 게시를 제3 CLI가 읽고, 경쟁자 게시 거부, 소유자 SIGKILL,
  만료 이후 후속 PID/fence 교체와 명시 release를 확인했다. 임시 DB/프로세스는 정리했다.
- staged 분기1개는 채널 의존성을 대체한 dispatcher 검증이다. 실제 운영 socket 인수가 아니다.
- 일반 GJC/runtime/CLI help 회귀49개 pass. 서비스/복구 첫 묶음과 중복되므로 합산 성과로 세지 않는다.
- lint/typecheck/backend build 통과. 로그는 daemon-*.log다. 전체 verify는 별도로 기록한다.
- 최종 집중 회귀 `daemon-regression-reviewed.log`: 14파일111개 pass, 56.40초.
  identity/실제 CLI/staged/process 및 기존 lease·health·settlement·migration 경로를 포함한다.
  앞선 묶음과 중복되므로 이 수치에 이전 테스트 수를 더하지 않는다.
- 후속 계약 명확화: 리뷰의 최초 실패 관측 캐시 지적은 기존 문서상 의도된 동작으로 철회됐다.
  구현은 첫 성공 게시를 기준으로 캐시하도록 개선했다. 신규 재시도3개는 수정 전 모두
  capture1회/기대2회로 실패했다(`daemon-recapture-before.log`). 이전 전체 verify는
  1차203파일1,344개 pass 후 이 변경 검증으로 전환하기 위해 SIGINT 종료했다(exit130).
  이 실행을 전체 통과로 취급하지 않는다.
- 캐시 계약 수정 후 `daemon-recapture-regression.log`: 14파일114개 pass, 60.45초.
  lint/typecheck/backend build/고정 시각 acceptance/CLI smoke도 exit0. 앞선111개와 합산하지 않는다.
- 새 독립 리뷰는 종료 상태를 target namespace/두 stat 확인 전에 반환하는 분기를 지적했다.
  종료+다른 namespace 2개, 종료+PID 재사용 1개를 추가했고 수정 전3fail/기존9pass를 확인했다.
  종료 판정을 동일 기동 확인 뒤로 이동했다. 수정 전 두 번째 전체 verify도 SIGINT 종료(exit130)했으며
  전체 통과로 계산하지 않는다. 최종 전체 검증은 새 리뷰 통과 후 실행한다.
- 종료 namespace 수정 후 `daemon-exit-namespace-regression.log`: 14파일117개 pass, 60.74초.
  lint/typecheck/backend build/고정 시각 acceptance/CLI smoke exit0. 이 수치는 이전 묶음과 중복된다.
- 코어 커밋 `6e4b4eb59dcf5fa872689abf58bfd271001520c4`의 전체 verify exit0:
  backend405파일2,678개, dashboard33파일205개 및 canonical gate 통과.
  `verify-6e4b4eb-after.json`의 전후HEAD 동일, changedTrackedFiles0. 뒤에 추가한 현황판
  변경까지 이 코어 전체 실행이 검증한 것은 아니다.

기준 커밋110227e의 전체 verify는 backend401파일2,643개, dashboard33파일205개 및 lint/typecheck/
build/고정시각 acceptance/CLI smoke를 통과했다. 전후HEAD/추적 bytes 동일. 이는 이 새 daemon 단위
이전의 전체 검증이며 이 단위의 전체 통과를 뜻하지 않는다.

## 운영 관측과 HOLD

메인 `6e101fc`가 기억 전달 원장에071을 먼저 확정하여, 통합 시 미배포 데몬 SQL 파일명을
071에서072로 배정했다. SQL SHA-256 `a57de8116e6cead4d4fdf88f6345f98b1b0da0c358f797fd2e8525aa87428fd0`
및 메인의 이전 SQL bytes는 보존한다. 아래71개 기준의 운영 관측은 이전 개발판의 기록이다.
그때 데몬071을 적용한 격리 사본은 통합판 검증에 재사용하지 않으며, journal을 바꾸지 않고
원본에서 새 격리 사본을 만들어야 한다. 운영 원본에는 데몬071/072를 적용하지 않았다.

2026-09-08T05:45:52Z 실제 운영 DB를 새 built CLI로 readonly 조회했다.
operator PID2347512, Node24.19.0/ABI137, 개발 source110227e/dirty=true다.
운영 daemon의 build로 대신 표시하지 않았고 daemon은 unknown/unavailable이었다.

- 운영 journal58개, 개발 기대71개: missing14/unexpected1/changed0.
- unexpected: `028_budgeted_evolution_memory.sql`, checksum
  `55faa41aa1c3c0b2c78ebfa4f59cd9daf6e4793deac91f39bfb3ea7e00955386`.
  개발 기대 목록에 동일 checksum 파일이 없다. missing은058~071이다.
- 실제 schema 객체1,284개; 정상 baseline 판정은 하지 않는다.
- 원자료: `daemon-production-readonly.json`, `daemon-production-vector-difference.json`.

**운영 migration/전환 HOLD.** 배포 SQL·해당 추가 기록의 기원·객체와 데이터 영향을 대조하고,
격리 복원본에서 호환 migration 및 quick_check/foreign_key_check/기능 인수를 검증한 뒤
운영자 지시 범위에서 적용해야 한다. journal 삭제/이름 변경이나 과거 SQL 수정으로 검사를
통과시키지 않는다. 이번 단위에서 운영 DB 변경·서비스 재시작·배포는 수행하지 않았다.
