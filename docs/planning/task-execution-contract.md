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
