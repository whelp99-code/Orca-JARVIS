# Claude 통합 작업 지시서 — §5 잔여 구현부터 최종 검증 제출까지

작성일: 2026-09-11 KST. 대상: JARVIS 개발 실행 담당 Claude.

## 0. 실행 지시와 최종 목표

**이 문서를 하나의 연속 작업으로 수행한다. R2 한 건 수정, 단위 커밋, 전체 verify 한 번 통과를 이유로 작업을 끝내지 않는다. 내부 수정·검증·리뷰를 마치고, 아래 완료 기준과 최종 제출 형식을 갖춘 결과를 Codex에 한 번 제출한다.**

사용자의 1차 목표는 JARVIS와 Second Brain을 실제 업무에 사용할 수 있게 만드는 것이다. Second Brain을 기반으로 유지·발전시키고 다른 오픈소스의 장점은 필요한 계약·기능으로 선별 흡수한다. 다른 개발 프로젝트는 이 두 시스템이 지원할 대상이며, 이번에 모든 프로젝트를 일괄 수정하는 범위는 아니다.

이 문서는 `cursor-handoff-2026-09-10.md` §5.A–D의 실행 순서와 종료 조건을 통합한다. 과거 문서는 증거·경위로 보존한다. 원본 01–25 중 이미 구현된 기능은 유지하고, 현재 잔여와 직접 관련된 부분만 완결한다. dev-wiki 폐기, 네 오픈소스 일괄 설치, 전체 코드 재작성, 미지원 실행자 전부 신규 개발로 범위를 바꾸지 않는다.

실행 원칙:

1. 이 문서의 M0–M6을 진행 원장에 등록하고 끝까지 수행한다. M1 종료 후 다음 지시를 기다리지 않는다.
2. 구현 가능한 일을 과거 문서의 `HOLD` 문구만 보고 보류하지 않는다. 일정 설정, 복구 프로토콜, 격리 인수, adapter 경계, 설정 예시, 승인 가능한 운영안은 개발 작업으로 완성한다.
3. 일상적인 구현 선택은 기존 계약·측정·회귀로 결정하고 근거를 기록한다. 작은 선택마다 사용자나 Codex에게 질문하지 않는다.
4. 내부 결함은 내부에서 수정하고 전체 영향 범위를 재검토한다. 새 P1을 고친 직후마다 Codex에 다음 리뷰를 요청하는 방식으로 끊지 않는다.
5. 외부 권한·계약이 실제로 없으면 그 의존 작업만 차단한다. 독립적으로 가능한 구현·검증·패키징·인계 준비는 계속한다. 접근 불가능한 증거를 만들어 내거나 권한을 자동 발급하지 않는다.
6. 진행 상황은 실행 환경에서 필요한 간결한 갱신과 원장으로 남긴다. 사용자 질문에는 답하되 작업을 중단하지 않는다. 장시간 무응답이나 중간 성공을 최종 완료로 포장하지 않는다.

## 1. 작업 공간, 기준점, 허용 경계

| 항목 | 이 문서 작성 시 확인값 / 실행 규칙 |
|---|---|
| 개발 worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| 문서 작성 직전 HEAD | `fc5b24a` — 최신 R2 검토 문서 커밋 |
| 최근 완료 gate의 제품 소스 기준 | `61d6de166344f62d2cd5003b6e1b1038ed37bd4b` |
| 그 뒤 기록 커밋 | `2f159e0`, `fc5b24a`; 제품 수정 완료를 뜻하지 않음 |
| 작성 시작 시 작업 상태 | tracked 변경 0; `?? .omo/evidence/ulw/`, `?? .omo/ulw-loop/`, `?? node_modules` |
| 앱 기본 cwd | `/home/jm/orca/projects/Orca-JARVIS`; 별도 checkout이므로 여기에서 구현하지 않음 |
| Second Brain | `/home/jm/orca/projects/second-brain-app`; 별도 작업자의 최신 진행 상태를 먼저 확인 |
| Second Brain 관련 task | `codex://threads/01a07b30-3b47-7552-879e-adae5ab6ec33` |

시작 시 값을 다시 읽는다. HEAD가 진행됐으면 후속 diff를 확인해 이미 수정된 부분을 보존한다. 문서 SHA로 checkout을 강제 되돌리거나 동료의 변경을 reset/stash하지 않는다. 필요한 격리는 Orca worktree 절차를 사용한다.

문서 검토 중에는 retention candidate/selection/apply 소스 3개와 consistency 테스트 1개의 미커밋 수정이 추가로 관측됐다. 이 진행 중 수정은 본 문서 작성자가 변경하거나 제품 검증하지 않았다. 아래 P1 실측은 고정된 61d6de1 기준이며, Claude는 현재 diff와 자기 진행 기록을 확인해 이미 처리한 수정을 중복 구현하지 않는다.

AGENTS.md, CONTROL_TOWER.md, ORCA_MASTER_CHARTER.md, 적용되는 하위 지침과 `docs/personal-os/release.md`를 읽는다. 리포 간 관례는 dev-wiki 정본을 확인한다. 실제로 사용 가능한 도구의 실행 결과로 판단하고, unavailable 도구·monitor·리뷰어를 호출한 것으로 기록하지 않는다. 고정 역할별 모델 배정을 복구하지 않는다.

이 작업의 개발 범위: 소스·테스트·문서 개선, 본인이 만든 격리 DB와 프로세스 시험, 로컬 단위 커밋, 독립 scratch 패키지와 운영 적용안 작성. 기존 승인·서명·lease·budget·privacy 경계를 유지한다.

운영 경계: push/merge/deploy, 서비스 재시작, 운영 DB·설정 변경, 실제 `current` 전환, 타 작업 산출물 삭제는 별도 명시적 지시가 있어야 실행한다. 이 문서가 새 운영 권한을 발급하지 않는다. 기존 세션의 유효한 허용 범위는 재질문 없이 적용하되, 격리 fixture 승인을 실제 운영 승인으로 바꾸지 않는다. 외부 메시지 전송도 이미 허용된 수신자·범위 안에서만 한다.

## 2. 현재 증거와 다시 열려 있는 결함

### 2.1 기존 전체 gate의 범위

`61d6de1`의 verify는 종료했다. 예전 메시지의 “실행 중” 상태로 기다리지 않는다.

- owner monitor: `mon_9YAYMPKRP0GXFC8A`; owner receipt 기준 RC 0, 종료 `2026-09-11T09:33:12+09:00`.
- 로그: `/home/jm/.cache/jarvis-lineage-qa/verify-bidirectional.log`; receipt: 같은 디렉터리의 `verify-receipts.json`.
- backend 275파일/1,886 + 275파일/1,917, dashboard 38파일/263 = 588파일/4,066테스트. backend 파일 수에는 두 shard의 집계가 들어간다.
- architecture: 658모듈/2,444간선/순환 0. 고정 acceptance: `pre_gjc_ready`, `stopped`, `completion_promoted=true`, `gjc_dispatched=false`.
- input digest: `sha256:329bb698943fe67a3aee9b3059d1c6dd64df880971da621bd70510ce10463fbc`.
- artifact digest: `sha256:d4d49f773735fce65c2d791489e5409c1b57edb3f1694a738e4470b4e3149571`.

이는 기존 테스트 통과 증거다. 아래 반례를 놓쳤으므로 R2 승인 근거가 아니다. 과거 APPROVE는 그때 검토한 트리에만 적용한다. 새 수정 트리에 소급하지 않는다.

### 2.2 반드시 읽고 회귀로 옮길 최신 리뷰

정본: `docs/opus-r2-exact-policy-review-2026-09-11.md`.
원본 재현: `/home/jm/.cache/jarvis-r2-exact-review-20260911/audit-and-values.mjs`.
결과: 같은 디렉터리의 `audit-and-values-result.json`, `aba-omission-result.json`, `build-identity.json`.

| 결함 | 현재 실측 | 고쳐야 하는 계약 |
|---|---|---|
| P1-A 감사 행 손실 | context를 가리키는 감사 행 1개를 뺀 ATTACH 대체 DB가 통과. 원본/정상 후보 audit 3, ABA 후보 2, apply 오류 없음·재검증 통과 | `personal_context_audit_events`는 삭제된 context ID를 담더라도 보존. 임의 열의 blocked ID 일치로 누락 허용 금지 |
| P1-B 비교 키 경계 충돌 | source의 두 열 `r s:/foo`, `/bar`와 candidate의 `r`, `/foo s:/bar`가 같은 직렬화 문자열. blocked=[]인데 값 변조 후보 통과 | 타입·열 경계·값을 모호함 없이 보존하는 정확한 비교 |
| 이전 작업 누락 | 61d6de1에서 작업 1건 누락 ABA는 MISSING_ROW로 거절; 정상 대조군 작업 1건 보존 | 이 수정과 FOREIGN_ROW, 원본 보존·후보 정리 회귀 유지 |

ATTACH 재현은 native `better-sqlite3`의 해당 prepare/run에만 테스트 wrapper를 넣어, 실제 ATTACH 직전 pathname 교체 후 직후 복원한다. 열린 연결은 대체 inode를 계속 읽는다. 제품 선택기·복사 SQL·검증기를 우회하지 않는다. wrapper와 파일은 finally에서 복구한다. “단일 스레드라 결정적 ABA 재현 불가”라는 과거 설명은 철회된 사실이다.

P1-B는 저장된 SQLite 행 값 비교의 반례이며 실제 보고서 생성 API나 운영 사고 재현이라는 주장은 하지 않는다. 재현 스크립트 자체 exit 0을 수정 성공으로 집계하지 말고 결과 필드를 단정한다.

## 3. 연속 수행 방식과 진행 원장

M0에서 `docs/claude-completion-progress-2026-09-11.md`를 만든다. 이 원장 하나를 재개 기준으로 사용한다. 기존 진행 문서를 모두 덮어쓰지 않는다.

각 단위에 다음 필드를 유지한다: `단위 ID / 상태 / 근거 SHA / 파일·계약 / 인수 항목 / 실행 결과와 receipt / 다음 명령 또는 다음 수정 / 외부 의존성`.

상태는 `TODO`, `IN_PROGRESS`, `VERIFIED`, `EXTERNAL_BLOCKED`로 구분한다. 테스트 미작성·내부 결함·검증 실패·패키지 미생성은 외부 차단이 아니다. `EXTERNAL_BLOCKED`에는 확인 시각·대상·없는 필드 또는 권한·확인 결과·준비된 adapter/patch/config·재개 절차가 모두 있어야 한다.

작업 순서:

| 단계 | 산출물 | 다음 단계로 갈 조건 |
|---|---|---|
| M0 | 기준·도구·계약·증거 목록, 진행 원장 | 현재 트리와 과거 검증 트리 차이 파악 |
| M1 | R2 전체 정확성 수정과 회귀 | 두 P1 및 과거 반례 차단, 정상 보존·삭제 정확성 |
| M2 | retention 복구·교체·일정화의 격리 구현 | 급사·경합·재시작 인수 통과 |
| M3 | 실제 생산자→context→추천→daily와 opt-in 연결 | fixture 수동 삽입을 넘어 제품 경로 인수 |
| M4 | Second Brain refresh·출처·삭제 연동 | 최신 계약 실제 연동, 또는 모든 로컬 작업 완료 후 구체적 외부 의존성 고정 |
| M5 | 실제 업무 준비·입력·기억 후보·성과 인수 | 가능한 실제 경로 실행, 권한 없는 동작은 완성된 적용안으로 분리 |
| M6 | 통합 리뷰·전체 gate·최신 패키지·최종 제출물 | §11의 종료 조건 충족 |

M0에서 M4/M5의 외부 의존성을 일찍 확인하되, 응답 대기 때문에 M1–M3을 멈추지 않는다. 이 표는 논리 의존 순서이며 두 구현자가 같은 파일을 동시에 수정하라는 지시가 아니다.

컨텍스트 압축·세션 재개 시 원장을 읽고 이어간다. 검증 도중 끝나면 process/monitor 식별자·로그·입력 digest·다음 회수 동작을 기록한다. 메모리 reflection 실패는 제품 테스트 실패나 커밋 손실 증거가 아니다. `reflection-run-93` 같은 도구 실패 때문에 목표를 잊거나 새 모델 설정을 임의 생성하지 않는다.

## 4. M0 — 기준 고정과 최소 조사

1. 정확한 worktree에서 branch/40자리 HEAD/status, tracking branch가 있으면 ahead/behind, Node/npm, 사용 가능한 scratch 공간을 측정한다. tracking 정보가 없으면 `not_configured`로 쓴다.
2. 진행 중인 자기 verify가 있는지 확인한다. 입력을 공유하는 verify 동안 제품·테스트·빌드 설정을 편집하거나 동일 dist를 다시 빌드하지 않는다. 완료·실패·중단 상태를 확정한 뒤 작업한다.
3. 아래 문서의 남은 조건과 실제 소스 차이를 읽는다. 과거 완료 코드는 재작성하지 않는다.

| 문서 | 용도 |
|---|---|
| `docs/cursor-handoff-2026-09-10.md` | §5와 01–25 원래 범위 |
| `docs/cursor-handoff-continuation-2026-09-10.md` | A–D 구현 경위와 과거 HOLD |
| `docs/opus-fix-final-reply-2026-09-11.md` | R1–R4 누적 기록; 최신 반례가 우선 |
| `docs/opus-r2-exact-policy-review-2026-09-11.md` | 현재 열려 있는 P1 두 건 |
| `docs/planning/local-timeline-daily-consumption.md` | 관측 소비·실제 producer 경계 |
| `docs/planning/task-daily-service-composition.md` | 기존 설정형 service·morning/evening 연결 |
| `docs/planning/daily-refresh-publication-contract.md` | provider refresh와 publication 구분 |
| `docs/planning/task-memory-source-privacy-hold.md` | task 자동 기억화의 출처·삭제 계약 |
| `docs/second-brain-oss-absorption-handoff-2026-09-07.md` | Second Brain 유지 및 OSS 흡수 방향 |
| `docs/personal-os/release.md` | Linux 격리 패키징·릴리스 경계 |

4. Second Brain은 최신 HEAD·관련 파일 dirty 상태·계약 버전·설치물 identity를 읽기 전용으로 확인한다. 과거 `d1d06e2`/`832bc6b` 결과를 최신 상태로 옮겨 적지 않는다. 작업 중 HEAD가 바뀌면 판독한 파일 digest와 시점을 고정한다.
5. 원래 migration 파일의 hash vector를 저장한다. 필요한 schema 변화만 새 번호로 추가하고, 이전 SQL 바이트 무변경을 최종 대조한다.

## 5. M1 — R2를 사례별 예외가 아닌 정확한 계약으로 마감

주요 진입점: `src/local-observation-retention-selection.ts`, `src/local-observation-retention.ts`, `src/local-observation-retention-candidate.ts`, `src/memory-authority-fresh-builder.ts` 및 이 builder의 compaction/restore 호출자.

### 5.1 수정 순서

1. P1-A/P1-B 재현을 정식 회귀로 넣고 현재 트리에서 기대한 실패를 확인한다. private scratch만 사용하고 원본 QA 증거는 보존한다.
2. 복사와 검증에 사용할 **같은 명시적 테이블별 keep/remove/transform 계획**을 만든다. 적어도 table·지정 column·projection kind/id를 결속한다. 행의 어느 값이 blocked ID와 같다는 이유만으로 삭제를 허용하지 않는다.
3. 대상 schema의 표·열·필수 trigger/index 계약을 양쪽에서 확인한다. candidate에 있는 표만 순회해서 source-only 표나 누락 열을 놓치지 않는다. 새 표가 생겼을 때 보존/변환 규칙이 묵시적으로 느슨해지지 않게 한다.
4. 원본의 허용된 변환 결과와 candidate를 양방향 비교한다. 외래 행·필수 행 누락뿐 아니라 **제거하기로 선정한 행을 남긴 후보**도 거절한다. 중복 multiplicity를 잃는 집합 비교로 축소하지 않는다.
5. `personal_context_audit_events`와 그 밖의 감사·권한·서명·receipt 기록을 실제 복사 계약대로 보존한다. 정상 삭제의 FK 참조 확장과 notification/deep_link/replacement 보류 규칙을 유지한다.
6. `local_timeline_subjects`의 snapshot/collection/expiry 초기화는 명시적 변환으로 검증하고 subject hold는 보존한다. shared builder의 control payload 정제 등 다른 변환도 호출 범위별로 정확히 검증한다.
7. `schema_migrations`는 수만 비교하지 말고 실제 version/checksum 등 현 schema의 전체 허용 벡터를 검증한다. `memory_database_generations`도 active 숫자만 보지 말고 builder가 보존·생성·전환할 정확한 행·필드·유일성 계약을 검증한다. 제외 표를 무검사 영역으로 남기지 않는다.
8. 모호하지 않은 typed tuple/길이 인코딩 또는 정확한 SQL 값 비교를 채택한다. 구분자만 바꾸지 않는다. 열 순서·NULL·빈 문자열·문자열 내부 토큰·blob·SQLite 숫자 의미와 64bit 정밀도 손실을 다룬다. JSON/Number 변환이 원래 값을 합쳐 버리지 않도록 한다.
9. 선택에 사용한 열린 source 연결의 snapshot/fence와 최종 검증을 일관되게 유지한다. pathname stat·fd identity·행 수·양 끝점 검사만으로 복사 내용 결속을 대체하지 않는다. `/proc/self/fd`를 쓸 수 없는 환경에서는 현재 fail-closed를 지키거나 동등한 검증을 먼저 구현한다.
10. 대량 DB에서 비교기의 메모리·시간·중단 경계를 측정한다. 전체 행을 무제한 JS Map으로 적재하는 비용을 새 운영 보장으로 포장하지 않는다. 필요한 범위의 bounded scan/SQL 비교/취소·예산을 적용하고 그 한계를 기록한다.

### 5.2 최소 인수 매트릭스

| 케이스 | 반드시 단정할 결과 |
|---|---|
| 선정 0 / 정상 복사 | 업무·감사·권한 행 값 보존; 명시적 cache/generation 변환만 발생 |
| 정상 cutoff 삭제 | 경계 포함 선정 그룹만 제거; 선정된 제거 대상 잔존 0 |
| 감사 행이 blocked context를 참조 | 감사 행 값·개수 보존; audit 3→2 ABA 거절 |
| 무관한 열에 blocked ID와 같은 문자열 | 허용 삭제로 판정하지 않음 |
| 공백과 `s:`를 포함한 기존 P1-B | 값 변경 candidate 거절; 정상 대조군 보존 |
| NULL/빈 문자열/blob/인용부호/숫자/큰 정수 | 계약상 서로 다른 값·열 조합을 구별 |
| FOREIGN_ROW / MISSING_ROW / multiplicity | 허용하지 않은 추가·누락·중복 거절 |
| 표·열·migration·generation 변조 | 개수나 active 숫자가 같아도 거절 |
| 같은 행 수·다른 내용, WAL→DELETE 및 DELETE→WAL | source identity 또는 내용 검증으로 거절 |
| native ATTACH ABA | 실제 바꿔 읽은 효과 차단; pathname 복구 여부 함께 단정 |
| notification / recommendation replacement 동시 쓰기 | source 변경 거절 또는 일관된 허용 snapshot만 사용 |
| 참조 중인 그룹 / cutoff 전후 / expiry 경계 | 선택기 보류·삭제 정책 그대로 유지 |
| 목적지 존재·동일/상대/symlink 별칭·sidecar·경쟁 생성 | 원본/기존 파일 무손상, 소유하지 않은 파일 미삭제 |
| 실패와 정상 완료 | source 논리 행 보존·fresh reopen·FK/integrity·자기 candidate 정리 |
| 공유 compaction/restore | 기존 목적지 mode·purge·audit·generation 계약 유지 |

원본 파일의 물리 bytes 불변과 논리 DML 무변경을 구분한다. builder의 `wal_checkpoint(TRUNCATE)`는 main/WAL/SHM에 영향을 줄 수 있다. preview의 읽기 전용 계약과 apply의 checkpoint 유지보수 계약을 혼동하지 않는다.

**M1 종료:** 위 반례와 정상 경로를 제품 API 및 compiled 경로에서 확인하고 관련 retention/shared builder 회귀를 통과시킨다. 전체 R2 구현을 재검토한 뒤 M2로 진행한다. 이 단계만으로 최종 회신하지 않는다.

## 6. M2 — 급사 복구, 안전한 교체, 일정화

### 6.1 부분 candidate 복구와 교체

현재 프로세스 급사 시 배타적으로 확보한 목적지에 부분 파일이 남고 재시도는 기존 파일을 거절한다. 이 보호를 유지하면서 복구 경로를 구현한다.

1. 기존 memory compaction/restore의 소유권·manifest·세대·교체 경계를 먼저 조사해 재사용한다. 두 번째 독립 authority/swap 체계를 만들지 않는다.
2. operation ID, source identity/세대/선정 digest, candidate 경로·소유 증거, 진행 단계, 검증 결과를 내구성 있게 기록한다. 준비 중·검증 완료·교체 완료·복구 필요를 구분한다. JSON 한 파일의 존재만으로 신뢰·삭제 권한을 부여하지 않는다.
3. 파일 이름의 재사용만으로 이전 실행의 partial을 덮어쓰거나 삭제하지 않는다. 재시작 후 소유·identity를 검증할 수 있는 자기 산출물만 정리/격리/재구축한다. 근거가 없으면 보존하고 구체적 오류를 반환한다.
4. 선정부터 복사·최종 검증·교체까지 writer 배타성 또는 동등한 CAS/fence 프로토콜을 설계한다. 교체 직전 검사 후에도 쓰기가 끼어들 수 있는 TOCTOU 창을 닫는다.
5. 파일 rename의 원자성만으로 SQLite 연결의 authority 전환을 선언하지 않는다. WAL/SHM, 기존 열린 연결, reader/writer 재개, generation 재확인, old/new authority 혼용 방지까지 검증한다. 실제 서비스 재시작 없이 가능한 개발 구현과 격리 프로세스 재개 절차를 완성한다.
6. 파일·manifest·디렉터리 durability 순서와 실패 복구를 명시한다. 이전 완전본 또는 새 완전본으로 복구해야 하며 혼합 상태나 silent success는 허용하지 않는다.
7. 별도 프로세스에서 claim 후·복사 중·검증 후·교체 직전/직후에 강제 종료한다. 결정적 barrier를 사용하고 임의 sleep 운에 맡기지 않는다. 재시작·동시 복구·경쟁 writer로 이중 교체/유효 데이터 손실/타 파일 삭제가 없는지 단정한다.

### 6.2 일정과 보존 정책

1. 기존 daily/service의 durable schedule·lease·fence·budget를 사용한다. 무설정은 비활성, adapter 없음은 unavailable/unsupported로 노출한다. callback 호출만으로 retention completed를 기록하지 않는다.
2. 현재 cutoff 설정 `{schema_version:1, retain_ms}`는 닫힌 레코드이고 허용 창은 `[300000,31536000000]`ms다. 추가 scheduling 설정이 필요하면 별도 명시 버전/스키마로 설계한다. 알 수 없는 키·잘못된 버전·범위·시각은 일관되게 거절한다.
3. 주기/시간대/일자 identity, 뒤로 간 시계·큰 전진·missed window, 중복 기동·재시작, 취소/예산 초과·실패 backoff를 구현·시험한다. 기존 production 값을 고치는 대신 검증 가능한 개발 설정 예시와 제안 근거를 작성한다.
4. notification이 참조하는 그룹은 기본적으로 보존한다. 자동 삭제/suppress로 사용자 대면 정책을 바꾸지 않는다. 이 보존 모드로 정상 일정화를 완성하고, 대안 정책은 비활성 제안으로 분리한다. 보류 그룹 수·오래된 보류·성장량을 구조화해 보인다.
5. snapshot cache 크기와 immutable 관측/감사 누적은 다르다. 반복 주기별 cache/observation/context/recommendation/audit 행 수, DB·sidecar bytes, 작업 시간·메모리를 측정한다. 감사·참조 보존 때문에 전체 용량이 계속 늘 수 있음을 정확히 표시한다.
6. candidate 동시 수·잔류 기간/용량, 수집 대상/회차/작업량 상한과 backpressure를 둔다. 한계 초과를 성공으로 숨기지 않는다. 감사 기록을 임의 삭제해 용량 목표를 맞추지 않는다.

**M2 종료:** 실제 격리 child process로 복구·교체·일정화 인수를 마치고 운영자가 검토할 설정/적용·복구 명령안을 만든다. 운영 적용 여부와 관계없이 구현 자체는 마감한다. 다음 M3의 opt-in 자동 접수를 연결할 수 있는 상태여야 한다.

## 7. M3 — 실제 생산자에서 daily 산출물까지

주요 진입점: `src/local-timeline-observation.ts`, `src/context-assembler-sources.ts`, `src/personal-context-evidence.ts`, `src/morning-recommendation-context.ts`, `src/morning-recommendation-source.ts`, `src/morning-brief-publisher.ts`, `src/morning-publication-lineage.ts`, `src/daily-loop-morning-execution.ts`, `src/daily-service-cycles.ts`.

### 7.1 생산자와 provenance

1. 기존 fixture는 필요한 증거 kind를 직접 구성한다. 이를 실제 assembler 생산 경로의 완료로 세지 않는다. `assemblePersonalContext`의 실제 출력 kind와 추천 입력 계약 차이를 확인하고 정식 adapter/타입 계약으로 연결한다.
2. 로컬 SQLite 사실을 terminal live fact, owner decision 또는 사용자 확정 원칙으로 이름만 바꾸지 않는다. source=`src:pos:v1:task-timeline:local`, authority=none인 advisory 관측의 의미를 유지한다.
3. confirmed memory가 있어야 sufficient인 기존 조건을 보존한다. 실제 계약을 통과한 memory와 현재 local observation을 제품 assembler→persist→추천 생성→발행 경로에 넣는다. 격리 fixture의 사용자 확인과 실제 사용자 확인은 보고에서 구분한다.
4. collection→observation의 ID/digest/TTL, context evidence refs, recommendation, brief contributor를 receipt로 연결한다. 테스트에서 최종 추천/brief 행을 직접 넣고 producer 통과라고 주장하지 않는다.
5. 접수 준비/쓰기/재검증 transaction과 소비 시 현재 원본 재검증을 유지한다. provider 비동기 IO를 SQLite transaction 안으로 가져오지 않는다.

### 7.2 중복, 철회, capped 결과

1. 같은 collection 재접수는 idempotent, 새 collection은 새 관측 ID다. 오래된 관측을 재사용해 cache 교체 뒤의 unavailable을 숨기지 않는다.
2. 업무상 동일성과 수집 identity를 분리한다. 동일 상태 재수집·동일 일자 재시작·중복 service에서 현재 actionable 추천과 brief item의 의도하지 않은 중복은 0이어야 한다. 최신 관측의 정당한 교체·갱신은 허용하고 근거를 연결한다.
3. 접수 전/후, context 생성 후, 추천 후, 발행 직전/후의 hold·quarantine·replacement·expiry·원본 변경/부재를 시험한다. 과거 저장 이력과 현재 행동 가능 표면을 구분하고 stale 자료가 현재 증거로 다시 등장하지 않게 한다.
4. 기존 발행의 `degraded/no_authoritative_data`, 현재 추천 제외, lifecycle 이력 보존 계약을 유지한다. 늦게 무효화된 후보 하나 때문에 매일의 나머지 정상 발행이 영구 실패하지 않게 한다.
5. 실제 TaskTimeline에서 예산 초과로 만든 capped 수집은 접수 unavailable과 brief 기권으로 이어져야 한다. capped를 정상 빈 결과로 바꾸지 않는다.
6. negative evidence 저장은 `migrations/028_negative_evidence.sql`의 승인·claim·receipt 경로를 재사용한다. 행마다 고유한 `control_command_requests` FK와 필요한 redemption을 갖추고 중복 재시도·권한 만료를 검증한다. 개발 fixture에서 합법적 경로를 만들 수 있는 일을 “FK 때문에 HOLD”로 끝내지 않는다. 실제 서비스에 그 권한이 없으면 미기록 이유를 명시하고 임의 승인 행은 만들지 않는다.

### 7.3 service와 프로세스 인수

- M2 통과 후 명시적 opt-in 등록 대상만 자동 접수한다. 전체 task 자동 등록이나 무설정 자동 실행은 하지 않는다.
- 실제 configured service의 morning/evening·local refresh·retention 순서와 실패 격리를 검증한다. coordinator 연결 실패를 로컬 발행 성공과 혼동하지 않는다.
- 정상 경로, 동일 시각 재실행, 다른 프로세스 재시작, 두 service 경쟁, hold/expiry/snapshot missing/실제 source missing/replacement/capped를 제품 handler와 프로세스 수준에서 검증한다.
- 기존 `tests/integration/daily-morning-cli-process.test.ts`와 `tests/fixtures/compiled-daily-cli.ts`를 재사용한다. 테스트용 고정 시계 wrapper와 실제 `dist/src/cli.js` 실행을 receipt에서 구분한다. 제품 clock bypass나 시스템 시계 변경을 추가하지 않는다.
- 고정 시각이 정책 effective_at·daily recovery window에 맞아야 한다. 올바른 제품 거절을 피하려고 정책/lease를 약화하지 않는다. invalid config는 쓰기 전 거절하고 DB 논리/물리 변화 검증 범위를 명시한다.

**M3 종료:** 수동 fixture 추천 삽입 없이 제품 생산·소비 체인이 성립하고, 내구성·중복·현재 유효성 인수가 통과한다. 운영자 키/실제 provider가 사용되지 않은 시험은 그 한계를 남긴다.

## 8. M4 — Second Brain 계약과 실제 연동

### 8.1 최신 refresh receipt 연결

기존 configured daily의 null refresh reader를 실제 adapter로 대체한다. 과거 확인에는 scoped request proof와 active generation 표면이 있었지만 cap/완전성·provider release·refresh↔scoped request 매핑이 부족했다. **부족하다는 과거 결론부터 반복하지 말고 최신 계약을 확인한다.**

1. JARVIS와 provider의 관련 계약 파일·버전·digest 및 실제 handler를 대조한다. 소스 HEAD, 빌드 identity, 설치된 release, 활성 generation은 서로 다른 값으로 기록한다.
2. request ID/digest, scope digest, provider instance, release identity, completion 시각, cap/완전성 outcome, generation/manifest, 현재 권한 및 필요한 tombstone/revocation 경계를 명시적 검증 모델로 만든다. 필드 이름은 최신 협상 계약을 따르며 임의 필드를 기존 닫힌 요청에 추가하지 않는다.
3. generation build 완료와 published/activated 상태를 구분한다. 과거 `PROVIDER_PROVED`나 마지막 성공 receipt만으로 지금 데이터를 읽을 수 있다고 판정하지 않는다. 같은 권한 fence 아래 active manifest·현재 scope 가용성을 대조한다.
4. provider IO 전후 lease/권한을 재확인한다. 요청 이후 취소·scope 축소·provider 교체·generation 전환이 있으면 오래된 응답을 현재 성공으로 사용하지 않는다.
5. 미설정, 실행 중/미완료, 실패, 비호환, capped, stale, 현재 완료를 구분하고 제품 현재 상태에 연결한다. local timeline refresh는 provider refresh 완료의 대체 증거가 아니다.
6. 정상·중복 request·재시작/uncertain ack·오래된 release/generation·scope 불일치·미래/만료 completion·cap·철회·activation 실패를 실제 adapter 입출력으로 시험한다. 제품 fallback이 fabricated success를 만들지 않아야 한다.

### 8.2 task 결과 → 기억 후보 → 출처·삭제 전파

`docs/planning/task-memory-source-privacy-hold.md`의 두 P1과 재개 조건을 구현 범위로 삼는다. 기존 scoped write/read/revoke 성공은 task 원본의 삭제 전파를 증명하지 않는다.

1. 검증된 task/request/run/completion과 결과 digest를 정확한 프로젝트·source 범위에 결합한다. terminal prose나 요약 생성 자체를 verified outcome으로 올리지 않는다.
2. 원본→검토 원문→기억 후보→사용자 결정→dispatch/outbox→provider record/검색의 영속 출처 관계를 만든다. 별도 기억 DB·승인 체계를 추가하지 않는다.
3. 후보는 advisory 검토 대상으로 생성한다. 자동 수집을 자동 사용자 확인으로 바꾸지 않는다. 비밀·제외 프로젝트·원본 hold를 접수와 소비 양쪽에서 검사한다.
4. 수집 전 task_id만 차단, 후보 생성 후 차단, 준비된 승인 명령 실행 전 차단, 승인 후 dispatch 전 차단, 전송 중 차단, 저장 후 삭제, 백업 복원 후 재유입을 시험한다.
5. uncertain 전송은 outbox의 동일 요청·reconciliation 계약으로 처리한다. blind retry로 중복 provider record나 뒤늦은 비인가 저장을 만들지 않는다.
6. 저장 후 provider의 직접 MCP 클라이언트 2개에서도 삭제된 파생 기억이 반환되지 않는지 검증한다. JARVIS 화면에서 숨기는 것만으로 완료하지 않는다. 인덱스·재색인·복원·generation 변경의 tombstone 적용도 포함한다.
7. 기존 모델이 lineage 필드를 거절하면 별도 버전/feature 협상을 구현한다. source 관계를 summary 본문에 숨겨 권한/삭제 계약을 우회하지 않는다.

### 8.3 모든 에이전트와 OSS 흡수의 범위

- 공통 memory 계약의 request/scope/receipt/idempotency/privacy/삭제 의미를 클라이언트별로 유지한다. 실제 연결한 클라이언트·전송 방식·지원 기능·미지원 기능을 호환표로 작성한다.
- Claude/Codex/Cursor 등 이름을 나열하는 것만으로 연결 검증을 대체하지 않는다. 같은 MCP 서버를 호출할 수 있다는 사실과 JARVIS의 native 업무 실행자 지원은 별개다.
- 이미 제공되는 정식 접속 방식과 최소 adapter를 우선한다. 아직 native 실행 계약이 없는 실행자는 unsupported로 유지하며 registry에서 선택 가능하게 만들지 않는다.
- OSS 검토가 구현에 필요하면 사용자 후보의 upstream 코드·문서·라이선스와 채택할 최소 부분을 검증하고 근거를 남긴다. 검색/그래프·기억 생명주기·코드 문맥·에이전트 접속 중 실제 공백을 메우는 부분만 채택한다. 전체 제품 교체나 검증 없는 기능/라이선스 단정은 하지 않는다.

### 8.4 provider가 아직 제공하지 않는 경우의 필수 산출물

상대 작업공간의 진행 중 파일을 직접 덮어쓰지 않는다. 기존 권한으로 격리 provider checkout 구현이 가능한지 확인하고, 불가능하면 다음을 **모두** 준비한 뒤 해당 교차 인수만 EXTERNAL_BLOCKED로 기록한다.

1. 최신 HEAD·파일 digest·판독 결과와 정확히 없는 필드/handler/권한 목록.
2. JARVIS 측 버전 협상·파서·fail-closed adapter·제품 상태 연결 및 계약 회귀.
3. provider 변경 제안: 정확한 요청/응답 schema, 예시 payload, digest/서명 범위, 오류/호환 규칙, 변경할 모듈과 데이터 이행 방안. 가능하면 적용 가능한 patch와 테스트 벡터를 인계 bundle로 생성하되 실제 적용하지 않은 patch를 구현 완료로 집계하지 않는다.
4. 양쪽 독립 프로세스를 연결하는 실행 가능한 격리 harness와 fixture. 아직 없는 계약으로 만든 fake provider는 contract test라고 표시하고 실제 provider 통과로 세지 않는다.
5. 상대 산출물이 도착하면 실행할 검증 명령·기대 결과·재개 위치. 답이 오면 최종 마감 전에 통합한다. 외부 전송이 허용되지 않았으면 전달문을 파일로 준비하고 “전송 완료”라고 쓰지 않는다.

**M4 종료:** 사용 가능한 실제 provider 계약을 연결해 인수하거나, 남은 상대 의존성을 위 산출물로 구체화한다. JARVIS에서 가능한 구현을 미완료로 남긴 채 “상대 과제” 한 줄로 종료할 수 없다.

## 9. M5 — 업무 실행, 실제 입력, 성과와 운영 적용안

### 9.1 승인된 업무 1건의 실행

진입점: `src/task-executor-registry.ts`, `src/task-executor-plan.ts`, 기존 승인·durable dispatch·서명 검증·completion 경로. 과거 개발 셸에서 아래 설정이 없었지만 현재 상태는 다시 확인한다.

- `JARVIS_TASK_CLAUDE_PATH`
- `JARVIS_TASK_VERIFIER_KEY_PATH`
- `JARVIS_TASK_VERIFIER_KEY_ID`

환경 변수 전체나 key 내용을 출력하지 않는다. 설정 키 이름·존재 여부·허용 경로 검증 결과·readiness 오류·검증된 release identity만 남긴다. 개발 셸, 격리 service 환경, 실제 운영 service 환경을 구분한다.

1. 기존 권한과 인증이 있으면 명시적 대상·허용 파일/행동·예산·성공 기준·rollback을 가진 실제 허용 업무 한 건을 선택한다. 기존 코드 수정/장애 보고/기술 검토 템플릿을 사용하고 새 실행 엔진을 만들지 않는다.
2. TaskSpec→plan digest→사용자 승인→durable dispatch→실제 native 실행→서명된 검증→완료의 receipt를 결속한다. 경로 probe나 프로세스 exit 0만으로 업무 완료를 선언하지 않는다.
3. 승인 만료·취소·scope 변조·낡은 fence·검증 key 불일치·uncertain 실행·재시작을 시험한다. 외부 효과 중복이 0이라는 주장은 실제 효과/중복 억제 경계의 측정으로 뒷받침한다.
4. native 실행을 위한 실제 인증이 없으면 격리 fixture 회귀·preflight·설정 manifest·구체적 업무안·적용/rollback 절차까지 완료한다. 모의 실행자나 새 fixture key를 운영 인증 증거로 대체하지 않는다.

### 9.2 외부 입력 1개와 업무 기억화

- 이미 허용되고 설정된 calendar/mail/messenger 중 필요한 읽기 입력 하나를 좁은 scope로 연결한다. 실제 source ID/digest/수집 시각·cap·만료·삭제 의미를 local input과 같은 계약으로 검증한다.
- 외부 인증이 없으면 현재 connector 경계·설정·정상/실패/중복/철회 fixture를 완성하고 필요한 접근권한을 정확히 명시한다. 비밀을 찾기 위해 광범위한 파일/환경 검색을 하지 않는다.
- task 결과 기억 후보는 M4.2의 출처·동의·삭제 계약을 통과한 경로로만 연결한다. 메일 발송·견적 전달·사용자 대신 기억 확정 같은 외부 행동을 입력 연결의 부수 효과로 켜지 않는다.

### 9.3 성과 측정과 최종 적용안

- 기존 signed completion 기반 성공/실패·승인 지연·재작업·shadow 결과를 실제 업무 receipt와 연결한다. 청구 비용이 없으면 `unavailable`로 표시하며 0원/절감률을 만들지 않는다.
- 실행되지 않은 후보와 실행된 결과를 동일한 실측 성과로 비교하지 않는다. 관측 결과만으로 routing 정책을 자동 승격하지 않는다.
- 운영 적용안에는 대상 release/provider identity, 설정 schema와 값의 근거, 등록 대상·주기·보존 정책, key 이름과 준비 상태, 예상 쓰기/외부 효과, 사전 gate, 적용 순서, health/readback, rollback 조건/명령을 넣는다. 비밀 값은 포함하지 않는다.
- 실제 활성화는 마지막 운영자 경계다. 그 전에 코드·격리 인수·패키지·실행 명령과 rollback을 검토 가능한 상태로 모두 준비한다. 개발에서 정할 수 있는 값을 이유로 먼저 멈추지 않는다.

**M5 종료:** 실제 권한이 있는 경로는 실행 증거를 제출하고, 없는 경로는 준비된 적용안과 정확한 의존성을 남긴다. 새 인증·사용자 확인을 만들어 “실제 업무 완료”로 집계하지 않는다.

## 10. M6 — 통합 리뷰, 전체 gate, 패키지 인수

### 10.1 단위 검증과 리뷰 순서

1. 소스 수정마다 의미 있는 대상 회귀를 실행한다. retention/shared builder, daily/service, provider/outbox/privacy, executor별 범위를 구분한다. unit/integration profile에 맞는 테스트만 집계한다.
2. 작은 기능 단위는 관련 gate 통과 후 코드+회귀+필요 계약 문서를 함께 로컬 커밋한다. `git add .`로 도구 상태나 타 작업 변경을 섞지 않는다.
3. 최종 구현 diff 전체를 리뷰한다. R2는 선택/복사/값 비교/metadata/원본 snapshot/교체/복구의 전체 계약을 검토하고, M3–M5는 실제 producer·현재 권한·삭제 전파·재시작을 포함한다.
4. 실행 환경에서 허용된 독립 리뷰 도구/리뷰어가 있으면 구현자와 분리된 검토를 받는다. 고정 모델 배정을 강제하지 않고 실제 이용 가능성과 권한을 따른다. 독립 리뷰가 불가능하면 구조화된 자기 감사와 재현 증거를 만들고 `independent_review=not_performed`로 명시한다. 같은 구현자의 재확인을 독립 APPROVE로 쓰지 않는다.
5. 발견된 문제는 수정→관련 회귀→수정 영향 재검토를 내부에서 반복한다. 열린 제품 P1/P2를 최종 검증 요청으로 떠넘기지 않는다. 외부 권한 부족과 내부 구현 결함을 구분한다.
6. 제품·테스트·계약·빌드 입력이 통합되고 리뷰 수정까지 끝난 안정된 트리에서 전체 verify를 수행한다. 단위 커밋마다 20분 전체 gate를 반복하지 않는다. 통합 후 추가 코드/테스트/설정 변경·실패·새 우려가 생기면 해당 입력으로 필요한 gate를 다시 수행한다.

현재 사용할 수 있는 명령 형식:

```bash
cd /home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui
npm run runtime:check
npm run build:backend
npm run test:integration -- tests/integration/local-observation-retention-consistency.test.ts tests/integration/local-observation-retention.test.ts tests/integration/local-observation-retention-destination.test.ts tests/integration/local-observation-retention-source-writes.test.ts
npm run test:integration -- tests/integration/local-observation-daily-cli.test.ts tests/integration/daily-morning-cli-process.test.ts tests/integration/daily-service-cycles.test.ts
npm run test:unit -- tests/unit/daily-control-loop-time.test.ts
npm run typecheck
npm run lint
npm run architecture:check
npm run verify
```

위 대상 명령은 시작점이다. 실제 변경한 shared builder/restore·provider·privacy·executor의 기존/신규 회귀를 추가한다. 실행 로그의 file/test 수로 실행 여부를 확인한다. 단순 문서 변경에는 제품 테스트를 새로 만들지 않는다.

`npm run verify`는 e2e를 포함하지 않는다. 최종 통합 인수에서 변경된 현재 상태/추천/lineage/재연결 UI를 확인할 필요가 있으면 격리 `npm run test:e2e`를 수행한다. browser가 없는 경우 실제 오류와 미검증 항목을 기록하고 허용된 환경 준비를 먼저 해결한다. production smoke를 격리 e2e의 대체로 무심코 실행하지 않는다.

### 10.2 gate receipt와 입력 고정

- 각 run은 새 디렉터리·새 log에 기록한다. 기존 verify5.log 같은 증거 파일을 덮어쓰지 않는다.
- command/argv/cwd, 시작 HEAD/tree, relevant input 파일 벡터와 digest, toolchain, 시작/종료 시각·종료 코드·signal, 구간별 실제 집계, log hash를 연결한다. verify 실행 중에는 해당 checkout의 입력과 dist를 변경하지 않는다.
- 종료 후 같은 입력 벡터를 재해시한다. 변경됐으면 그 run을 최신 gate로 채택하지 않는다. 종료 코드 미회수·중단·실패·입력 불일치는 PASS가 아니다.
- monitor가 있으면 실제 회수 주체를 쓴다. 다른 담당자가 준 RC는 owner receipt로 표기하고, 본인이 monitor를 직접 회수했다고 쓰지 않는다.
- 최종 문서 커밋 때문에 HEAD가 달라지면 제품 검증 SHA/테스트 입력 SHA와 제출 HEAD를 구분한다. `git diff -- src` 0만으로 전체 gate 입력 무변경을 주장하지 않는다. tests/dashboard/migrations/scripts/config/lockfile 등 실제 입력 범위를 대조한다.
- test 수는 이번 실행에서 측정한다. 과거 4,066을 목표 수치로 맞추거나 통과하지 않은 케이스를 합산하지 않는다. 정적 architecture 순환 0은 검사기의 범위에 대한 결과다.

receipt 형식은 기존 구조를 재사용하되 다음 정보가 빠지지 않게 한다:

```json
{
  "schema_version": 1,
  "run_id": "<unique>",
  "command": ["npm", "run", "verify"],
  "cwd": "<absolute>",
  "source_head": "<40-hex>",
  "source_tree": "<git-tree>",
  "input_digest_before": "sha256:<digest>",
  "input_digest_after": "sha256:<digest>",
  "toolchain": {"node": "<observed>", "npm": "<observed>"},
  "started_at": "<ISO-8601 with timezone>",
  "finished_at": "<ISO-8601 with timezone>",
  "exit_code": 0,
  "signal": null,
  "result_source": "<direct-process or identified-owner-receipt>",
  "counts": {"backend_shard_1": {}, "backend_shard_2": {}, "dashboard": {}},
  "log": "<absolute>",
  "log_sha256": "<digest>",
  "input_stable": true
}
```

이 JSON은 형식 예시이며 실행 결과가 아니다. 미실행 항목은 null/not_performed로 기록하고 예시의 RC 0을 그대로 복사해 채우지 않는다.

### 10.3 최신 제품 패키징과 재검증

1. 최종 제품 입력의 complete runtime package를 새 private scratch에 만든다. 과거 `jarvis-runtime-o06V8W` 등은 이번 제품 변경을 포함하지 않으므로 최종 패키지로 재사용하지 않는다.
2. 패키징은 build를 수행하므로 전체 verify와 동시에 실행하지 않는다. source/input/artifact와 payload/dependency 벡터를 확인하고, build 중 입력이 바뀌면 원인을 해소한 뒤 다시 수행한다.
3. 패키지 생성 성공 시 receipt SHA256을 독립된 QA manifest에 저장한다. 후보 검증 시 후보 자신에서 기대값을 다시 생성하지 않는다.
4. 신뢰하는 개발 checkout의 verifier로 고정 receipt를 검사한다. 패키지 CLI/runtime identity와 실제 packaged dashboard HTTP를 시험한다. 개발 checkout의 node_modules나 src를 암묵적으로 참조하지 않는지 확인한다.
5. M2/M3 최종 프로세스 시험을 필요한 범위에서 packaged runtime으로 실행한다. Second Brain도 실제 격리 설치물/프로세스로 연결해 정상 읽기·쓰기, scope, 현재 generation, 철회를 확인한다. fixture identity/키/clock 사용과 native 모델 미호출 여부를 명시한다.
6. signed/sealed manifest가 필요한 경로는 기존 계약과 키 경계로 검증한다. 로컬 hash 일치를 서명·source attestation·운영 승인으로 표현하지 않는다. 실제 운영 서명이 없으면 개발 fixture 검증과 미충족 운영 gate를 구분한다.

실재하는 명령 형식이다. `<...>`는 이번 run에서 생성/확인한 절대 경로와 값으로 바꾼다:

```bash
node scripts/package-authority-runtime.mjs --output-parent <existing-private-scratch-parent>
node scripts/verify-runtime-package.mjs <absolute-package-root> --receipt-sha256 <independently-pinned-64-hex>
node scripts/packaged-dashboard-http-probe.mjs <absolute-package-root> <new-http-receipt-path>
node scripts/personal-os-release-rehearsal.mjs --fixture test/fixtures/personal-os/full-loop.json --clock 2026-08-27T07:15:00+09:00 --release-root <isolated-release-root> --json
```

packager는 locked production dependencies를 offline 설치한다. cache miss는 실제 원인대로 해결하되 몰래 online 설치로 전환하지 않는다. 기존 release rehearsal는 완전한 runtime payload가 아니므로 그것 하나로 deployment readiness를 주장하지 않는다. package/HTTP/integrity 성공도 기본적으로 `deployment_ready=false`인 개발 증거다.

### 10.4 자원·도구 실패 처리

- `/tmp`는 과거 usrquota EDQUOT가 있었다. `$HOME/.cache` 아래 본인 소유 private scratch를 새로 만들고 `TMPDIR`을 그곳에 명시한다. 테스트 러너의 자체 scratch 설정을 확인한다. HOME/CODEX_HOME을 다른 용도로 덮어쓰지 않는다.
- 공간 부족은 자기 run의 불필요한 파일만 소유권 확인 후 정리하거나 새 경로로 우회한다. sangfor/mail/electron 등 타 작업 산출물이나 공유 node_modules를 지우지 않는다. 실패 증거는 보존한다.
- 긴 테스트는 도구의 비동기 실행/종료 회수 방식을 사용한다. 기존 실행을 확인하지 않고 중복 verify를 띄우지 않는다. unchanged 상태를 반복 보고하는 자동화를 만들지 않는다.
- reflection/리뷰 도구가 실패하면 실제 상태를 원장에 남기고 가능한 로컬 작업을 이어간다. 실행하지 못한 도구를 성공으로 채우거나 그 실패를 제품 결함으로 집계하지 않는다.

## 11. 최종 판정과 제출물 — 이것이 종료 조건이다

### 11.1 종료 가능한 상태

| 최종 상태 | 필수 조건 | 사용할 수 없는 주장 |
|---|---|---|
| `READY_FOR_CODEX_FINAL_REVIEW` | 허용된 개발 범위 M1–M6 구현·회귀·통합 gate·최신 패키지 증거 완료, 내부 차단 결함 없음. 실제 운영 단계의 수행 여부 별도 표기 | Codex의 최종 승인·운영 활성화가 이미 끝났다는 주장 |
| `READY_FOR_CODEX_FINAL_REVIEW_WITH_EXTERNAL_BLOCKERS` | 위 개발 작업 중 외부 의존성 없는 부분 전부 완료. 외부 계약/인증/운영 권한이 필요한 항목만 §8.4와 §9의 완성된 준비물 및 재개 조건으로 고정 | 01–25 전체 완료, 미검증 provider/native 실행/실제 운영 완료 |
| `IN_PROGRESS` | 제품 결함, 미완료 구현, 누락 회귀, 실패 gate, 미생성 package, 불충분한 조사 등 내부 작업 잔여 | 최종 제출·완료 선언 |

실제 환경 장애가 지속되어 검증을 완료할 수 없으면 원인·증거·완료한 우회·정확한 재개 동작을 기록한다. 그것을 검증 PASS로 바꾸지 않는다. 단지 작업이 길거나 복잡하다는 이유, 단위 커밋이 만들어졌다는 이유는 최종 상태 전환 조건이 아니다.

### 11.2 제출 파일

1. `docs/claude-completion-final-reply-2026-09-11.md`: Codex가 이 문서만 읽고 최종 검증할 수 있는 회신서. 실제 마감 날짜가 달라지면 파일명과 본문 날짜를 함께 맞춘다.
2. `docs/claude-completion-progress-2026-09-11.md`: 완료/외부 잔여로 정리한 원장. 기존 불일치 TODO를 그대로 두지 않는다.
3. private QA root의 `final-manifest.json`: 아래 목록과 각 산출물의 절대 경로·sha256·기준 SHA·실행 여부를 연결한다. git에 비밀/DB/거대로그를 넣지 않는다.
4. 필요한 경우 `docs/claude-second-brain-contract-handoff-2026-09-11.md`: 실제 미충족 provider 계약·patch/벡터·재개 절차. 상대에게 전송됐는지 여부를 명시한다.

최종 회신서의 필수 내용:

- 최종 상태, 제품 SHA/검증 입력 SHA/문서 포함 HEAD, branch·tracked M/D/??·ahead/behind의 실제 수치.
- 사용자 목표→M1–M6→원본 §5.A–D/01–25의 대응과 각 완료/외부 잔여 판정.
- commit 목록과 각 단위 변경 이유. 제품 코드·테스트·문서 변경을 구분하고 과거 검증을 새 코드에 소급하지 않은 근거.
- R2 모든 반례의 before/after 표: 감사 3→2, 값 경계 충돌, 작업 누락, FOREIGN_ROW, 같은 행 수, journal 조합, ATTACH ABA, 선정된 삭제 잔존, metadata·schema·목적지·동시 쓰기·급사 복구.
- 실제 source→collection→observation→context→추천→brief 계보와 반복/재시작/철회/capped 결과.
- provider 계약/설치물/활성 generation·scope·refresh·삭제 전파와 두 클라이언트 검증 결과; 합성 fixture와 실제 provider를 분리.
- 실제 업무의 승인→실행→서명 검증→완료 receipt 또는 정확한 인증/권한 부족 및 준비 완료한 적용안.
- 대상 테스트·전체 verify·필요 e2e·프로세스·패키지 각 명령/RC/시각/로그·hash·입력 일치 여부. failed/aborted/invalid run을 합격 근거에서 제외한 목록.
- 독립 리뷰의 실제 도구/수행자·입력 SHA·범위·판정·열린 항목. 수행하지 못했다면 그 사실.
- migration 기존 바이트 비교, 새 migration 목록, source 논리 쓰기와 checkpoint의 물리 영향, final package/receipt pin.
- 실제 수행한 운영/외부 행동, 수행하지 않은 행동, 외부 blocker별 소유자·필요 입력·준비된 파일·재개 명령·통과 기준.
- Codex용 **최소 재검증 절차**: 정확한 checkout/SHA 확인 → 원본 P1 재현/정식 회귀 → 최종 receipt와 입력/hash readback → package 검증 → 결론. 이미 통과한 전체 gate를 이유 없이 재실행하라는 지시를 넣지 않는다.

원장과 회신서는 문서만 남겨도 검증 자료를 추적할 수 있어야 한다. QA 파일이 다른 머신에서 접근 불가능하면 재현 가능한 script/fixture와 실행 방법을 제공한다. 원본 증거 위치만 적고 실행에 필요한 파일을 버리지 않는다.

### 11.3 마지막 자체 체크

다음이 모두 참인지 실제 파일·로그·diff로 확인한다:

- 두 P1에 사례별 임시 예외를 붙인 수준을 넘어 복사/검증의 전체 허용 변환이 일치한다.
- 급사·writer 경합·재시작 및 실제 producer 경로가 중간 HOLD로 남지 않았다.
- provider 미지원/인증 부재와 내부 미구현을 구분했고 가능한 준비 작업을 끝냈다.
- 활성화하지 않은 기능을 운영 완료로 표시하지 않았으며 구현한 기능을 과거 HOLD 문구 때문에 누락하지 않았다.
- 제품·테스트·패키지·문서의 기준 SHA와 receipt 범위가 서로 설명 가능하다.
- 추적 변경과 미추적 도구 상태를 구분했고, 자신의 산출물만 커밋했다.
- Codex에게 요구하는 다음 행동은 최종 검증이며, 내부 구현을 다시 설계하거나 P1을 순차 발견해 달라는 요청이 아니다.

그 후 로컬 문서 커밋을 남기고 최종 회신서·manifest 위치와 최종 상태를 제출한다. 이 문서 자체를 읽었다거나 계획을 세웠다는 답변으로 종료하지 않는다.

## 12. 원본 01–25 추적표

아래는 기존 인계에서 확인한 개발 상태를 출발점으로 한 매핑이다. 최종 회신서에는 각각 구현 근거·이번 회귀/인수·운영 상태·정확한 잔여를 추가한다. 전부 신규 구현하라는 표가 아니며, 기존 완료 사실을 전체 운영 완료로 확대하는 표도 아니다.

| ID | 기존 개발 상태 | 이번 확인/잔여 연결 |
|---|---|---|
| 01 | redaction 구현 | 비밀 비노출 유지; M4/M5 receipt에도 적용 |
| 02 | owner/lease/fence 구현 | M2/M3 실제 두 프로세스 배타성 유지 |
| 03 | 만료 settle 차단 구현 | M4/M5의 IO 후·재시작 권한 정산 유지 |
| 04 | TaskSpec 제약·예산·digest 구현 | M5 실제 승인부터 검증까지 결속 |
| 05 | 구조화 liveness 구현 | local SQLite/등록/terminal prose를 live로 승격 금지 |
| 06 | 전체 활성 SQL count 구현 | 목록과 전체 count 계약 유지 |
| 07 | 미지원 retention 상태 구분 구현 | M1/M2 실제 adapter와 보존·복구·일정화 |
| 08 | 조회 암묵 초기화 제거 구현 | preview/readiness/현재 조회의 쓰기 계약 유지 |
| 09 | retry 만료 권한 검사 구현 | M2/M4/M5 재시도에서 권한 자동 연장 금지 |
| 10 | readiness·격리 실행, 운영 미완료 | M5 인증/설정·실제 허용 업무·적용안 |
| 11 | Claude 승인→실행→검증 구현 | M5 native 실행과 완료 증거 |
| 12 | 설정형 daily/service·일부 retention 구현 | M1–M4 전체 소비·생산·반복·provider 연결 |
| 13 | supervisor/coordinator 장애 분리 구현 | M3 phase 결과와 transport 실패 구분 |
| 14 | static runtime 순환 검사 구현 | M1–M5 새 경계 검사; 파일 수 목표 리팩터 금지 |
| 15 | server/Electron 분리 구현 | M6 서버 package에 GUI 설치 강제 금지 |
| 16 | SQL pagination·메모리 개선 구현 | legacy 전체 배열의 한계 유지; M1 대량 비교 비용 측정 |
| 17 | SSE backpressure/재연결/구독 상한 구현 | 변경 UI 소비 검증; 전체 RSS·공정성 보장으로 확대 금지 |
| 18 | test profile·직렬 shard·scratch 개선 구현 | M6 의미 있는 회귀·정확한 입력/RC receipt |
| 19 | runtime identity·package integrity 구현 | M6 최신 package·서명/activation 경계·운영 적용안 |
| 20 | version routing preview 구현 | 검증·승인 없이 외부 자동 행동 활성화 금지 |
| 21 | Claude registry 구현, Codex native unsupported | M4 공통 memory 호환표와 M5 실행자 지원을 구분 |
| 22 | scoped 쓰기/조회/철회 과거 실증 | M4.2 task→후보→record 출처·동의·삭제·복원 인수 |
| 23 | local cache·명시 관측 구현 | M3 실제 producer, M4 refresh, M5 허용 외부 입력 1개 |
| 24 | 코드 수정/장애 보고/기술 검토 3템플릿 구현 | M5 실제 업무 적용; 메일/견적 외부 행동은 권한 경계 |
| 25 | signed 성과·승인 지연·재작업·shadow 구현 | M5 실제 결과/청구 접근 여부; 미측정 비용·효과를 0으로 표기 금지 |

## 13. Claude에게 붙여 넣을 시작 문구

> `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui/docs/claude-completion-instructions-2026-09-11.md`를 실행 지시서로 삼아 현재 작업을 이어가라. M0–M6과 §11 종료 조건을 모두 처리하고, 단위 수정·커밋·verify 통과 때마다 나에게 다음 지시를 요구하지 말라. R2 두 P1부터 급사 복구·일정화·실제 producer/daily·Second Brain 연동·업무 준비·최신 패키지 인수까지 내부에서 수정과 검증을 이어가라. 과거 HOLD는 최신 코드·계약으로 재평가하고, 개발 가능한 일은 완료하라. 실제 외부 계약·인증·운영 권한만 구체적 준비물과 재개 조건으로 분리하라. 승인되지 않은 운영 변경이나 권한 생성은 하지 말라. 마지막에는 Codex가 최종 검증할 회신서와 증거 manifest를 한 번 제출하라. 진행 원장을 남겨 컨텍스트가 바뀌어도 이어가라.
