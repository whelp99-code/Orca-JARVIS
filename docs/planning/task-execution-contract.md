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
