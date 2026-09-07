# 일반 작업의 실행 계약

상태: 개발 중. 개선 항목04/10/11/21의 구현 설계. 운영 실행 활성화 완료가 아니다.

`workflow.start`는 기존처럼 workflow를 생성한다. 실제 실행은 별도 `task.execute` ControlPlane 요청에 서명한다. 요청은 원래 TaskSpec digest와 실행계획 전체의 digest를 포함한다. 자연어 scope를 파일 권한으로 해석하지 않는다.

실행계획 v1은 provider, 격리 후보 작업 모드, 정본 저장소 경로와 기준 commit, 읽기/변경할 파일의 기준 digest, 네트워크 금지, 시간/출력 상한, 검증 argv/cwd/예상 종료 코드를 명시한다. 새 파일은 기준 digest null이며 읽기 전용 파일에는 null을 허용하지 않는다. 경로는 상대 파일명이며 glob, 상위 이동, Git 관리 경로를 허용하지 않는다. 정적 경로 검증은 실제 filesystem의 symlink/하드링크/경합 검증을 대체하지 않는다.

먼저 실행계획 작성·workflow 결합·승인 요청 생성을 제공한다. 실제 adapter와 독립 검증이 준비되기 전 `task.execute`는 executable=false이다. 요청 생성/승인은 agent 호출을 일으키지 않는다. 승인된 실행계획을 검사 없이 활성화하거나 이 값을 임의로 true로 바꾸지 않는다.

후속 실행 구현은 `ApprovedCommandExecutor`와 `ControlEffectAttempts`를 재사용한다. `run_id + execution_plan_digest`의 영속 결합으로 새 요청을 통한 재전송을 차단하며, 호출 전 invoking 기록 이후 불명확 결과는 uncertain으로 유지한다. 추천 전용 테이블에 가짜 recommendation을 만들지 않는다.

Codex 또는 Claude는 격리 사본에서 후보 변경을 생성한다. 정본 반영은 별도의 허용 파일 검사·원본 digest 대조·현재 승인 재검증 경계에서 수행한다. 검증기는 실행자와 분리된 프로세스/키로 실제 후보 파일과 검증 명령을 확인한다. 작업자가 출력한 성공 문구는 완료 증거가 아니다. LoopGraph 완료 전이는 결합된 PASS 증거를 요구해야 한다.

완료 인수는 대시보드 작업 생성→시작 승인→기계적 실행계획→실행 승인→실제 agent 후보 변경→독립 검증→허용 파일 반영→결과 표시를 동일 task/run/plan digest로 추적한다. 계획 단계 검증만으로 이 인수를 완료 처리하지 않는다.

## 계획 작성 CLI

```sh
jarvis control plan-task plan.json --db /absolute/path/to/authority.sqlite
```

JSON 최상위 필드는 `request_id`, `nonce`, `requested_by`, `plan`이다. `plan`은 `src/task-execution-plan.ts`의 `TaskExecutionPlanV1`을 따른다. 임의 추가 키는 거부한다.

| 계획 필드 | 요구 값 |
|---|---|
| schema_version / run_id / task_id | 버전 1, 이미 승인되어 시작된 workflow와 동일한 ID |
| task_spec_digest | 해당 workflow에 저장된 TaskSpec의 SHA-256 |
| provider / mode / network | codex 또는 claude / isolated_candidate / deny |
| repository | 정규화된 절대 root, 전체 40자 또는 64자 commit hash |
| files | 1–128개 상대 파일 경로, read 또는 write, before_digest; 신규 write 파일은 null |
| limits | timeout_ms 1,000–600,000, max_output_bytes 1,024–1,048,576 |
| verification | 1–8개 고유 id, 1–64개 문자열 argv, 상대 cwd 또는 `.`, expected_exit 0 |

응답의 `request.state=pending`은 별도 승인 요청이 저장되었다는 뜻이다. 요청 만료는 원래 workflow 마감과 15분 중 이른 시각이다. 같은 request_id/nonce/요청자/계획을 다시 제출하면 쓰기 없이 기존 요청을 반환한다. 변경된 계획에 같은 request_id를 사용하면 `TASK_EXECUTION_REPLAY_CONFLICT`다.

직접 `LoopGraph.start()`로 만든 승인 이력 없는 workflow, 변경된 TaskSpec, 원래 승인과 불일치하는 workflow 입력, 취소/완료/만료된 workflow는 거부한다. 이 CLI는 저장소 파일·실제 commit 존재·provider 설치나 인증을 검사하지 않으며 agent를 실행하지 않는다. 실제 경로/원본 digest 검증과 준비 상태 표시는 후속 adapter preflight에서 수행한다. 승인 후 `control execute`를 호출해도 현재는 `APPROVED_ACTION_UNKNOWN`으로 실패하며 실행 효과 0개다.

## 저장소 검사와 후보 입력 사본

```sh
jarvis control check-task plan.json --db /absolute/path/to/authority.sqlite
```

`check-task`는 계획과 workflow의 결합을 검사 전후에 확인하고, 실제 Git root/HEAD와 선언한 파일의 바이트 digest를 대조한다. Git 조회는 상속된 `GIT_*` override를 제거하고 global/system config와 fsmonitor를 비활성화한다. JSON 결과는 `repository.state=checked`, `execution_available=false`이며 파일 내용은 포함하지 않는다. 검사 시각의 입력 확인 결과이며 실행 시 다시 검사해야 한다.

현재 구현은 Linux의 descriptor-relative 경로와 `O_NOFOLLOW`를 사용한다. 정규화된 정본 경로와 사용자 소유 일반 파일만 지원하며 symlink/하드링크/특수 파일을 거부한다. 기존 파일은 최대 4 MiB, 전체 선언 파일은 최대 16 MiB다. 새 파일의 null digest는 실제 부재와 일치해야 한다.

`prepareTaskExecutionWorkspace(plan, privateParent)`는 같은 검사를 거친 바이트만 별도 후보 디렉터리에 복사한다. parent는 기존 사용자 소유 private 디렉터리여야 하고 원본 저장소 내부에는 사본을 만들지 않는다. 후보 및 하위 디렉터리도 FD로 고정하고 파일을 exclusive/no-follow로 생성한다. 반환된 snapshot digest는 계획과 입력 파일 메타데이터를 결합한다. 이 함수는 승인/agent 실행/원본 반영을 수행하지 않는다.

실패한 private 후보는 자동 재귀 삭제하지 않는다. 경로가 동시 교체됐을 때 관계없는 디렉터리가 지워지는 것을 피하기 위한 보존이며, 완료된 실행 원장과 결합한 안전한 보존·정리 정책은 후속 작업이다. 사본의 파일 mode는 초기 접근 권한일 뿐 같은 UID의 실행자를 격리하는 보안 경계가 아니다. 실제 provider의 OS sandbox, 읽기 전용 입력 강제, 승인·원본 재검증과 검증 후 반영 경계는 여전히 필요하다.

## 실행 시도 영속 결합

Migration `058_task_execution_binding.sql`은 기존 `control_effect_attempts`에 `task_run_id`와 `task_plan_digest`를 추가한다. 두 값의 unique index는 요청/영수증/lease fence가 바뀌어도 같은 계획의 operation을 하나로 제한한다. 기존 migration 파일은 수정하지 않는다.

`ControlEffectAttempts.prepareTask(command, clock)`은 IMMEDIATE 트랜잭션 진입 후 현재 시각을 읽고 원본 요청 digest, 전체 인수, 현재 claim/redemption/fence, 요청·승인·lease 만료, Ed25519 서명과 현재 decision key, 철회, workflow/TaskSpec/예산을 확인한다. 같은 operation이 있으면 상태와 무관하게 `TASK_EXECUTION_ALREADY_BOUND`로 거부한다.

`beginTaskInvocation(command, clock)`은 같은 권한을 다시 확인하고 prepared→invoking을 CAS로 한 번만 기록한다. 이후 결과 불명확 시 `markTaskUncertain`은 만료·취소 뒤에도 해당 요청/영수증/fence의 uncertain 기록을 허용한다. 일반 `update`는 task 행의 성공 처리를 허용하지 않는다. 원장의 invoking은 호출 직전 기록이며 실제 provider 호출 성공이나 업무 완료 증거가 아니다.

INSERT OR REPLACE의 명시적 식별자·operation·SQLite rowid 충돌과 UPDATE OR REPLACE의 rowid/별칭 충돌도 DB trigger로 차단한다. prepared/uncertain을 포함한 기존 operation의 자동 초기화·재예약은 제공하지 않는다. 호출 전 중단된 prepared 기록의 재개, invoking 중 종료된 프로세스의 조정, 검증 증거와 최종 정산은 후속 구현이 필요하다.

이 원장은 아직 ApprovedCommandExecutor의 일반 task 실행 경로에 연결되지 않았다. provider 격리·독립 검증·원본 반영이 완성될 때까지 `task.execute`는 executable=false를 유지한다.

## 후보 바이트 검증기

`verifyTaskCandidate(plan, files)`는 계획에 선언된 파일과 정확히 같은 집합의 후보 바이트를 받는다. 읽기 전용 파일은 원래 digest와 일치해야 하며 파일당 4 MiB/전체 16 MiB를 넘으면 실행 전에 거부한다. 후보를 복사해 고정하고 계획 digest·파일 digest·바이트 수를 포함한 candidate digest를 만든다. 각 검증 명령은 별도 사본을 사용한다.

기본 runner는 Linux `/usr/bin/bwrap`이다. `--unshare-all --unshare-user --disable-userns`로 namespace를 분리하고, 환경변수를 비우며, 현재 Node 실행 파일과 시스템 `/usr/bin`, `/usr/lib`, 선택적 `/usr/lib64`만 읽기 전용으로 제공한다. 후보 데이터는 별도 pipe에서 `--ro-bind-data`로 복사한다. 호스트 후보/원본 디렉터리·홈·인증 파일·AuthorityDb를 mount하지 않는다. `/workspace`와 root는 읽기 전용이고 `/tmp`는 64 MiB의 별도 tmpfs다. 네트워크 namespace도 분리한다.

계획의 argv/cwd를 직접 실행하며 shell 문자열로 재해석하지 않는다. Node는 `/runtime/node`에 있어 `node` 명령으로 접근한다. 다른 도구는 제공된 시스템 경로 안에 있어야 한다. 후보 파일 mode는 0400이므로 스크립트는 명시적 인터프리터로 실행한다. 의존성 다운로드·호스트 node_modules 공유는 제공하지 않는다.

모든 검증 명령에 하나의 시간/출력 예산을 적용한다. stdout/stderr 원문을 결과에 포함하지 않고 각각의 digest와 바이트 수만 반환한다. 시간/출력 초과 시 bwrap 프로세스 그룹에 SIGKILL을 보내고 stdio close 뒤 반환한다. PID namespace와 die-with-parent는 세션을 분리한 자손 종료에 사용한다. 실제 시험에서 자손 1개가 종료 후 Z로 관측됐으므로 호스트의 즉시 reap은 보장하지 않는다.

결과는 `checks_passed` 또는 `checks_failed`다. 함수 자체는 승인 서명을 검사하거나 완료 증거에 서명하지 않는다. 작업 승인, provider가 반환한 후보와의 결합, 독립 verifier 신원/키, 원본 반영 및 workflow 정산을 연결해야 최종 완료 증거가 된다. 이 함수를 호출할 수 있다는 사실은 task.execute 활성화 조건을 충족하지 않는다.

실행기 조사에서는 설치된 CLI help와 [공식 Codex 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference)를 대조했다. 문서는 command network 규칙이 web search/apps/MCP에 적용되지 않는다고 명시한다. 따라서 CLI의 network 옵션 하나만으로 전체 provider의 외부 효과를 차단했다고 보지 않는다. 이번 구현·실측 범위는 독립 검증 명령의 bwrap 실행이며 provider 본체의 인증·통신·도구 격리는 후속이다.

## 승인된 Claude 후보 생성과 검증 연결

`executeTaskCandidate({ authority, command, provider })`는 이미 서명되어 claim된 실행계획의 후보 생성 단계를 연결한다. 현재 권한 확인→실제 Git/파일 입력 대조→TaskSpec 전체와 입력 사본 준비→영속 operation 예약/invoking→provider 호출→반환 후보 검사→원본 재검사→격리 검증을 수행한다. provider와 검증기의 실제 spawn 직전에도 동기 승인/lease 검증을 호출한다. 실행 파일을 비동기로 준비하는 동안 취소·만료됐으면 프로세스를 시작하지 않는다. 실행 파일 준비 시간도 monotonic deadline에서 차감한다. 최초 Git/파일 캡처·문맥 준비 이후, operation 예약부터 provider 호출·원본 재검사·검증까지 wall clock과 monotonic clock 중 먼저 도달하는 마감을 적용한다. 최초 입력 캡처·문맥 준비 시간은 이 공유 마감에 포함되지 않는다.

Claude 구현은 설치된 CLI를 신뢰하는 도구 없는 추론 경로다. `--safe-mode`, 빈 `--tools`, `--strict-mcp-config`, MCP 도구 차단, slash command 비활성화, session 비저장, 빈 setting-sources, dontAsk를 사용한다. cwd는 `/`, 상속 환경은 HOME/PATH/LANG/TZ뿐이다. 기존 Claude CLI 인증으로 API 통신하며 provider 자체를 bwrap 안에서 실행하지 않는다. [공식 CLI 문서](https://code.claude.com/docs/en/cli-reference)의 safe-mode는 managed-policy hook을 유지하므로 모든 호스트 hook이 차단된다고 주장하지 않는다. 현재 호스트에서 해당 managed settings 파일은 없음을 확인했다. 운영 readiness에서 설치 CLI·인증·관리 정책을 다시 확인해야 한다. 계획의 network deny는 후보 검증 명령에 적용하며 모델 API 통신까지 차단한다는 뜻이 아니다.

입력은 전체 TaskSpec/계획/선언 파일을 포함한 최대 512 KiB의 UTF-8 문맥이다. 이 범위를 넘거나 바이너리 입력이면 잘라 보내지 않고 거부한다. 구조화 응답은 계획 digest와 정확한 write 상대 경로/전체 파일 내용만 허용한다. 중복·누락·추가 키·읽기 전용 변경·비정상 UTF-8·크기 초과를 거부하고 read 파일은 원본 사본에서 유지한다. stdout/stderr 합산 출력 예산은 provider와 모든 검증 명령이 공유한다.

반환 상태 `candidate_checked`에는 후보 바이트와 `checks_passed` 또는 `checks_failed` 측정 결과가 들어가며 `published=false`다. 성공 시 현재 원장은 invoking, 요청은 claimed로 남으며 workflow 상태를 변경하지 않는다. 호출 시작 뒤 예외는 uncertain이며 새 승인 요청으로 같은 계획을 자동 재호출하지 않는다. 후보는 아래 영속 artifact에 결합한다. 실행 재개/정산, 독립 verifier 서명, 허용 파일 반영과 workflow 완료는 후속 구현이다. Codex 후보 provider도 미구현이다. 이 단계만으로 `task.execute`를 활성화하지 않는다.

## 후보 영속 저장과 읽기 전용 회수

기존 control_effect_attempts의 operation 하나에 후보 artifact 하나를 연결한다. 별도 실행 큐나 파일 저장 서비스를 만들지 않고 SQLite의 제한된 BLOB으로 바이트를 원자적으로 기록한다. provider 출력 형식·경로 검증 뒤, verifier 실행 전에 현재 서명·claim을 다시 확인하여 저장한다. 후보 identity/내용은 변경·삭제·교체할 수 없고 로컬 검증 결과만 별도 단일 기록으로 결합한다. 후보 저장 뒤 종료되면 검증되지 않은 후보를 회수할 수 있지만 provider를 재호출하거나 업무 완료로 정산하지 않는다.

읽기는 현재 실행 권한을 부여하지 않는 이력 조회다. lease 만료 뒤에도 저장된 바이트와 결합 digest를 검사해 회수하며 조회가 원장 상태를 변경하지 않는다. 저장 크기/파일 집합/계획·후보·payload digest, 검증 명령 순서와 결과를 확인한다. 실제 디스크 중단·재개와 동시 저장은 별도 프로세스로 검증한다. 이 기록은 독립 verifier 서명·원본 반영·workflow 정산을 대신하지 않는다.

`TaskCandidateArtifacts.save()`는 invoking 상태의 정확한 request/receipt/fence/run/plan 결합을 확인한다. 후보 파일은 파일당 4 MiB/전체 16 MiB이며 base64를 담은 canonical JSON BLOB은 24 MiB 이하로 제한한다. source snapshot은 선언된 원본 digest·바이트 크기·실행 비트의 manifest를 재계산해 검사한다. 후보의 read 파일은 원래 digest와 같아야 한다. 이는 로컬 입력 관측의 일관성 검사이며 원본 관측에 대한 외부 서명이 아니다.

Migration 059는 operation별 attempt_id를 PK/FK로 사용하고 WITHOUT ROWID와 INSERT/UPDATE/DELETE trigger로 교체·삭제·내용 변경을 차단한다. 저장은 현재 권한을 transaction 진입 후, 실제 INSERT/UPDATE 직전, read-back 뒤 COMMIT 직전에 확인한다. 같은 바이트/같은 측정의 재저장은 SQL 쓰기 없이 기존 결과를 반환하고 다른 바이트/측정은 충돌로 거부한다. 기존 058과 이전 migration 바이트는 수정하지 않는다.

`recordVerification()`은 저장된 candidate digest와 파일 manifest, 계획의 체크 ID/순서/종료 코드, provider와 검사들의 합산 출력 예산을 대조한다. 모든 검사가 없는 PASS, 중간 실패 뒤 추가 결과, 상태와 종료 코드의 불일치를 거부한다. 검증 JSON은 최대 허용 파일 목록을 수용하도록 256 KiB로 제한하며 JSON/digest/기록 시각은 함께 한 번만 기록한다. 후보 artifact와 검증 기록은 별도 COMMIT이므로 검증 결과가 없다는 사실을 보존한다.

`read(requestId)`는 SQL에서 BLOB·측정·계획 크기를 먼저 제한한 뒤 정규 base64, 디코딩 크기, 원본/후보 manifest와 각 digest를 검사한다. 별도 SQLite 연결이나 프로세스 재시작 후에도 읽을 수 있고 lease 만료·uncertain 상태에서도 원장을 수정하지 않는다. 반환 artifact_id는 payload와 실행 시도에 결합된 로컬 식별자이며 실행 허가나 독립 검증 서명이 아니다.

복구 보장은 후보 INSERT의 COMMIT 이후부터다. 모델 응답 수신과 COMMIT 사이 종료되면 후보가 없을 수 있으며 기존 invoking 기록으로 재호출을 계속 차단한다. 검증 전 중단됐거나 측정이 없는 artifact의 자동 검증 재개, 최종 정산, 보존/삭제 정책과 운영 데이터 용량 관리는 후속이다. 현재 저장은 운영 DB에 적용하지 않았으며 task.execute 활성화 조건은 여전히 충족하지 않았다.

## 독립 검증 증거와 프로세스 간 공유 마감

독립 검증은 기존 verifier 공개키/목적/주체 레지스트리를 재사용하고 decision 공개키와 정규화한 공개키 바이트가 같은 키를 거부한다. task artifact에 결합된 검증 예약을 만들고 별도 verifier 프로세스가 reserved→running을 1회 CAS로 획득한다. 검증 invocation nonce를 각 실행과 서명에 결합한다. 마지막 서명 저장의 멱등성만으로 실제 검증 실행 중복을 방지했다고 보지 않는다.

프로세스가 바뀌어도 실행 시간 예산이 늘어나지 않도록 provider 호출 전에 부팅 ID·time namespace와 Linux uptime 기준 마감을 기존 operation에 고정한다. 읽기 시 10ms 출력 정밀도를 보수적으로 차감하고 부팅 또는 time namespace가 바뀌면 재개를 거부한다. 기존 deadline 없는 operation을 소급해 새 예산으로 채우지 않는다. wall clock 승인/lease 만료와 각 프로세스의 monotonic 타이머도 함께 적용한다. provider·기존 측정·독립 검사 출력은 같은 예산을 공유한다.

별도 verifier는 저장 후보와 현재 승인/검증 invocation을 직접 확인하고 bwrap으로 실제 명령을 실행한 후 결과에 서명한다. 검증 private key는 이 프로세스가 읽고 검사 sandbox에 전달하지 않는다. 서명은 attempt/request/receipt/fence, artifact/payload/plan/TaskSpec, 검증 예약과 invocation, key/시각/측정을 결합한다. 부모는 현재 권한·키 철회·서명·예산·파일/명령 결합을 다시 검사해 단일 증거로 저장한다. 서명 기록과 전체 검사 PASS를 구분하며, 원본 반영과 workflow 완료는 별도 후속 경계다.


Migration 061은 기존 operation에 clock_id와 deadline_uptime_ms를 prepared→invoking 시 한 번만 기록한다. 마감은 Linux `/proc/uptime`의 boot-time 값으로 계산하고 `/proc/self/ns/time` 식별자를 포함한다. Linux 구현의 기준은 [proc uptime](https://github.com/torvalds/linux/blob/master/fs/proc/uptime.c)이다. migration 이전 invoking 기록에는 새 마감을 부여하지 않는다. 입력 캡처 이전부터의 전체 요청 시간을 제한하는 기능은 별도 후속이다.

Migration 062의 task_candidate_certifications는 artifact별 예약 1개, 검증 invocation 1개, 증거 1개를 보존한다. `TaskCandidateCertifications.prepare/begin/record/requireProof`가 기존 command/receipt/fence와 현재 TaskSpec·workflow를 대조한다. `recorded`는 서명된 측정의 기록이며 checks_failed도 보존한다. 최종 PASS 소비자는 measurement.state와 전체 계획의 검사 통과를 요구해야 한다. 서명 domain은 `orca-jarvis/task-candidate-verification/v1` 뒤 NUL이다.

별도 entry는 `node dist/src/task-verifier-main.js <absolute-db-path> <absolute-private-key-path>`이고 stdin은 command와 verification_id만 받는다. 외부에서 준비한 Ed25519 verifier 키를 읽으며 런타임이 새 신뢰 키를 생성하지 않는다. 키 파일은 현재 UID 소유 일반 파일·0600 이하·단일 링크·16 KiB 이하·직접 절대 경로만 허용한다. 이 검사는 별도 OS 사용자 격리가 아니다. 검증 entry는 호스트의 신뢰 프로세스이며 bwrap 검사 자식에게 DB나 키를 전달하지 않는다. 실제 운영 연결에는 신뢰 가능한 verifier 프로세스 실행/키 배포 및 출력 수집이 필요하다.

예약 후 시작 전 중단은 reserved, 시작 후 프로세스 강제 종료는 running과 proof 없음으로 남는다. 자동 재실행은 허용하지 않는다. entry가 잡은 오류는 uncertain으로 기록하며 lease 만료 후에도 그 사실을 보존할 수 있다. 서명 후 부모 저장 전 중단도 증거가 없을 수 있다. 이 단계는 종료된 프로세스 식별·운영 복구·최종 command 정산을 제공하지 않는다. 원본 파일 반영, 증거에 따른 workflow 완료, UI 동선 및 Codex provider는 후속이다. 부모 프로세스 연결은 아래 통합 호출이 담당한다. `task.execute`의 executable=false를 유지한다.


## 후보 생성부터 독립 검증 증거 저장까지의 통합 호출

`executeCertifiedTaskCandidate`는 현재 서명/등록 verifier 키와 실제 공유 DB 경로를 확인하고, 검증 실행 파일·키 파일의 메타데이터를 검사한 뒤 기존 후보 생성과 `certifyTaskCandidate`를 연결한다. 상대경로로 AuthorityDb를 열어도 `PRAGMA database_list`의 실제 main 파일 절대경로를 사용한다. 메모리 DB는 별도 프로세스가 공유할 수 없으므로 모델 호출 전에 거부한다.

`NodeTaskVerifierProcess`는 현재 Node 실행 파일과 배포된 task-verifier-main.js만 사용하며 작업 인수로 실행 파일을 선택하지 않는다. cwd `/`, 빈 환경, shell=false, 독립 프로세스 그룹으로 실행한다. 부모는 private key 바이트를 읽지 않고 경로만 전달한다. 파일 경로 준비 후 실제 spawn 직전에도 reserved 상태·승인·lease·영속 마감의 남은 시간을 확인한다. 프로세스의 monotonic 타이머와 이 마감 중 먼저 만료되는 제한을 적용한다.

stdin은 최대 4 MiB, stdout/stderr 합계는 proof 메타데이터 512 KiB와 진단 4 KiB로 제한한다. 이 프로토콜 한도는 실제 검사 stdout/stderr에 적용하는 승인된 공유 출력 예산과 별개다. 검사 출력 예산은 후보 provider·로컬 검사·독립 검사를 모두 합산한다. 시간/출력/입력 전달 실패에서는 프로세스 그룹을 종료하고 close 이벤트를 기다린 뒤 고정 오류 코드만 반환한다. 원문 stderr와 private key 내용은 결과에 포함하지 않는다.

부모는 받은 JSON의 invocation을 현재 예약과 대조하고 기존 proof 검증기로 서명·후보·명령·시간·철회를 재검증하여 저장한다. 자신이 새 예약을 만든 이후 실패한 경우 operation을 uncertain으로 보존하고 자동 재생성을 막는다. 기존 예약과의 충돌은 그 예약의 상태를 변경하지 않는다. 반환 `candidate_certified`는 서명된 측정의 저장이며 `checks_passed`는 로컬 검사와 독립 검사가 모두 통과해야 true다. `published=false`와 workflow running은 유지한다.

실행파일 검사는 직접 확인한 파일이 일반 파일이고 그룹/다른 사용자 쓰기 권한이 없는지 검사한다. 일반 개발 build가 umask에 따라 664 파일을 만들면 TASK_VERIFIER_UNAVAILABLE로 중단한다. 배포 패키지는 entry뿐 아니라 전체 코드·의존성과 상위 디렉터리를 신뢰 가능한 권한으로 준비해야 한다. 현재 사전 검사는 전체 의존성 트리의 무결성 증명이나 개인 키/공개키 짝의 사전 인증 검사가 아니다. 등록 키와 private key 일치는 실제 verifier entry에서 확인한다. 운영 패키징/readiness의 완결과 자동 실행 활성화는 별도 후속 범위다.

## v2 실행계획과 검증된 Git 결과 게시

v1 `isolated_candidate`의 권한과 canonical 형식은 유지한다. 새 v2는 `mode: verified_git_commit`과
`publication: { ref, repository_identity }`를 서명에 포함한다. ref는 새 `refs/heads/codex/<name>` 한 개이며
기존 이름의 교체, 현재 HEAD 변경, 작업 트리 덮어쓰기, push/merge/deploy 권한은 부여하지 않는다.
설계 근거는 [게시 ADR](adr-task-git-publication.md)이다.

승인 전에 `inspectTaskPublicationIdentity(root)`로 실제 root/git-dir/common-dir의 정규 경로와 device/inode
digest를 읽는다. v2 입력 캡처 전후·게시 open·중단 후 조회가 이 값을 대조한다. `.git` 파일을 동일 commit이
있는 다른 저장소로 바꾸거나 경로에 새 저장소를 놓아도 이전 승인으로 게시·정상 복구 판정을 하지 않는다.
저장소를 이동하거나 복원해 identity가 달라진 경우 새 계획/승인이 필요하며 자동 재결합하지 않는다.

`executeTaskPlan`은 기존 후보 생성·독립 서명 검증을 호출하고 v2의 로컬/독립 검사 모두 PASS일 때만
`publishTaskGitCandidate`를 호출한다. 실패 측정과 v1은 기존 인증 결과로 반환하며 게시하지 않는다.
게시기는 현재 승인/receipt/fence/키 철회/영속 마감과 전체 후보·서명 binding을 다시 확인한다.

Git baseline의 선언 파일 bytes/mode를 검증 입력과 비교하고 별도 private index에 검증된 write 파일만
반영한다. read 파일이 dirty였거나 baseline에서 symlink인 부모를 일반 디렉터리로 바꾸어야 하는 변경은
거부한다. 최종 tree의 전체 선언 파일과 baseline 대비 changed paths를 다시 검사하며 빈 diff도 거부한다.
최종 커밋은 baseline을 단일 부모로 갖고 후보 및 독립 증거 digest를 메시지에 기록한다. Git 커밋 자체에
GPG 서명하지 않으며 별도 원장의 Ed25519 proof와 publication binding으로 연결한다.

Git plumbing은 bwrap 안에서 고정 `/usr/bin/git`과 빈 환경으로 실행한다. Git metadata는 읽기 전용이며
고정 FD로 연 objects·codex ref 디렉터리·private index만 쓰기 가능하다. 현재 작업 파일·홈·DB·인증은
mount하지 않고 네트워크 namespace를 분리한다. hooks, filters, fsmonitor, 자동 GC, reflog 생성과
commit signing을 끈다. stderr 원문은 반환하지 않으며 명령별 남은 마감/출력 상한을 지킨다.
호스트에서 새 codex 디렉터리를 준비할 때도 common FD부터 O_NOFOLLOW로 하위 경로를 고정한다.
이 경계는 신뢰된 호스트 publisher와 커널을 전제로 하며 동일 UID의 호스트 장악에 대한 보안 보장은 아니다.

Migration 063은 단일 publication의 building→prepared→published 또는 uncertain 상태를 보존한다.
예상 tree/commit을 SQLite에 COMMIT한 뒤 `update-ref --no-deref`의 create CAS로 새 ref만 생성한다.
기존 direct/symbolic/dangling symbolic ref는 교체하지 않는다. journal의 identity·내용 교체/삭제·역방향
상태 전환은 trigger가 차단한다. Git 효과와 SQL 완료는 원자적이지 않으므로 응답 유실은 미확정으로 남긴다.

`inspectTaskGitPublication`은 lease 만료 뒤에도 기존 binding·저장소 identity·실제 ref를 대조하여
ref_absent/ref_matches/ref_conflict를 반환한다. SQL 상태 변경, private index 생성, writable mount,
ref 재생성은 수행하지 않는다. SIGKILL 직전/직후의 prepared 기록도 읽을 수 있지만 관측이 실행 재승인이
되지는 않는다. 생성 후 회수되지 않은 객체, 강제 종료 후 private index의 안전한 보존/정리는 후속 운영 범위다.

통합 반환은 `candidate_published`, `published=true`, publication/ref/commit/tree와 서명된 검증 결과다.
이 게시 API만 호출하면 operation은 invoking, request는 claimed, workflow는 running이다.
아래 통합 완료 API가 명령·workflow 정산을 담당한다. 중단/취소 복구와 결과 UI,
Codex provider·배포 준비 및 운영 인수는 남아 있으므로 `task.execute`의 executable=false는 유지한다.

## 검증된 게시 결과와 workflow 완료의 원자적 정산

`executeTaskWorkflow`는 v2 승인과 현재 TaskSpec, 정확한 기본 agentops loop ID·canonical 정의·digest,
step/node 예산과 deadline을 확인한 뒤 후보 생성→독립 인증→Git 게시→정산을 연결한다.
v1 후보 전용 승인은 모델 호출 전에 거부한다. 검사 실패는 `candidate_certified`, `published=false`로
반환하며 완료로 승격하지 않는다. 사용자 정의 loop의 추가 gate를 건너뛰는 용도로 사용할 수 없다.

`settleTaskExecution`은 이미 published인 현재 요청의 승인·fence·서명·마감을 재검사하고
저장소 identity와 실제 direct ref의 commit을 확인한다. Git ref 관측과 SQLite COMMIT은 원자적이지 않다.
영수증의 `observed_at`은 관측 시각이며, immutable commit/tree가 산출물이다. 이후 ref 이동·삭제가
과거 성공 기록을 자동 취소하지 않으며, 과거 기록 조회가 현재 ref 존재를 보장하지도 않는다.

Migration 064의 run별 단일 immutable completion receipt를 한 IMMEDIATE transaction에서 기록하고
operation confirmed, command completed/effect, workflow step·transition·완료·event를 함께 확정한다.
기존 observe/assess/approval 단계를 실행한 것처럼 이벤트를 만들지 않는다. 현재 node에서 complete로
`task_verified` 한 전환을 기록하고 전체 step와 현재 node 시도 예산을 각각 1회 소비한다.
완료는 승인된 검사와 게시 산출물의 충족이며, 자연어 목표 전체·merge·push·배포의 성공 증명은 아니다.

일반 ControlPlane 정산이나 직접 SQL로 영수증 없이 task를 완료할 수 없다. INSERT OR REPLACE가
기존 task를 비-task 내용으로 위장하거나 rowid/_rowid_/oid 충돌로 원장을 교체하는 경로도 차단한다.
정산 도중 실패와 마지막 만료·철회 검사는 전체 정산을 rollback한다. 이미 생성된 Git ref는 유지된다.

COMMIT 전 실제 SIGKILL에서는 완료 기록이 없고 기존 published/invoking/claimed/running이 남는다.
COMMIT 후 종료에서는 receipt/confirmed/completed가 함께 남는다. 동일한 아직 유효한 published 요청은
정산만 다시 시도할 수 있으나 provider·verifier·Git 게시를 자동 반복하지 않는다. 완료 전 만료·취소·
철회된 요청의 새로운 권한 부여나 uncertain publication 복구는 이 API 범위 밖이다.

`readTaskCompletion`은 publication/artifact/명령·operation·workflow·effect·step·transition을 대조해
기록된 완료 사실을 반환한다. 현재 실행 권한을 새로 부여하지 않으며 현재 ref를 조회하지 않는다.
완료된 동일 요청의 통합 재호출도 읽기만 수행하고 인수가 다른 요청의 결과를 재사용하지 못하게 한다.
Approved executor·CLI/UI의 정산 호출 연결, 실패·중단 운영 복구와 task.execute 활성화는 후속이다.
