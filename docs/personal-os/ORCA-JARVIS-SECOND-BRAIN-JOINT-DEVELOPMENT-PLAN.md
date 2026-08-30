# ORCA–JARVIS–Second Brain 통합 개발계획서

- 문서 상태: **재기획 실행 기준선 초안 — 기존 독립형 계획은 SUPERSEDED**
- 작성 기준일: 2026-08-29
- 대상 프로젝트:
  - `Orca-JARVIS`: `/home/jm/orca/projects/Orca-JARVIS`
  - `second-brain-app`: `/home/jm/orca/projects/second-brain-app`
- 주 실행 환경: `jm-cloud` Ubuntu
- 주 사용자 환경: macOS + ORCA
- 대상 에이전트: OMP/Luna, Claude Code, Codex, Orca Worker 및 MCP 호환 에이전트
- 문서 목적: ORCA 중심 개발 방식, JARVIS 컨트롤타워, Second Brain 장기기억을 하나의 운영 구조로 정렬하고 기존 독립형 Terminal Work Memory 계획을 교체한다.
- 대체 대상: `TERMINAL-WORK-MEMORY-DEVELOPMENT-PLAN.md`의 독립형 구현 순서

---

## 1. 조사 결론

### 1.1 JARVIS와 Second Brain 연동은 JARVIS 개발계획에 이미 포함돼 있다

현재 `Orca-JARVIS`의 `.omo/plans/jarvis-personal-operating-system.md`에는 다음 통합이 명시돼 있다.

- Second Brain을 durable personal memory로 사용
- JARVIS를 유일한 execution authority/control plane으로 유지
- Second Brain stdio MCP transport 및 read adapter
- memory candidate, outbox, reconciliation
- Daily Control Loop에서 Second Brain 기억을 근거로 사용
- 검증된 작업 결과를 Second Brain에 되돌려 쓰는 cross-repository saga
- Mac은 클라이언트, Linux는 권위 있는 런타임

따라서 사용자의 판단대로 Terminal Work Memory는 JARVIS 개발과 분리해서 기획하면 안 된다.

### 1.2 그러나 현재 실제 통합 코드는 아직 구현되지 않았다

2026-08-29 현재 JARVIS `main`에서 다음 계획 파일은 존재하지만 실제 구현 예정 파일은 없다.

```text
missing src/second-brain-transport.ts
missing src/second-brain-adapter.ts
missing src/personal-contracts.ts
missing src/personal-validation.ts
missing migrations/032_personal_context.sql
missing migrations/033_personal_operations.sql
missing docs/personal-os/architecture.md
missing docs/personal-os/contracts.md
missing config/personal-os-policy.json
```

현재 JARVIS 기준선:

```text
branch: main
HEAD: 57dec90
working tree: dirty
plan status: READY FOR FRESH REVIEW — DO NOT EXECUTE UNTIL APPROVED
```

즉 연동은 **방향과 상세 계획에는 존재하지만, 운영 코드로 완료된 상태는 아니다.**

### 1.3 기존 Terminal Work Memory 계획의 핵심 수정점

기존 계획은 다음처럼 Second Brain이 터미널 원장을 직접 소유하는 구조에 가까웠다.

```text
Shell Collector
  → Second Brain Terminal Ledger
  → Failure / Resolution / Summary
```

이 구조는 JARVIS 역할과 중복된다.

올바른 구조는 다음이다.

```text
ORCA / Shell / Agent
  → JARVIS Operational Observation & Authority Ledger
  → 검증·상관관계·실패/해결·closeout
  → Memory Candidate / Approved Outbox
  → Second Brain Durable Knowledge
```

**실시간 작업 사실과 운영 상태는 JARVIS가 소유하고, 검증된 장기기억만 Second Brain에 남긴다.**

---

## 2. 고정 아키텍처

### 2.1 세 시스템의 역할

| 시스템 | 고정 역할 | 소유하지 않는 것 |
| --- | --- | --- |
| ORCA | 실행면, Worker·terminal·worktree·agent session lifecycle | 승인 권한, 장기기억 정본 |
| JARVIS | 컨트롤타워, 관측·승인·실행 통제·검증·운영 원장 | 개인 장기지식 원본, 직접 코딩 |
| Second Brain | 검증된 장기지식, 출처·충돌·검색·회상 | 실시간 제어권, Worker dispatch, 승인 영수증 |
| Unified DB | 선택적 관측/증거 아카이브 및 교환 계층 | 실행 권위, 최종 장기기억 권위 |
| Mac | ORCA와 에이전트 및 UI 클라이언트 | production authority DB, scheduler, 독립 memory authority |
| jm-cloud | JARVIS와 Second Brain의 권위 있는 상시 런타임 | Mac 로컬 상태 의존 |

### 2.2 한 문장 정의

> ORCA가 일을 수행하고, JARVIS가 그 일을 통제·관찰·검증하며, Second Brain이 검증된 결과와 교훈을 장기기억으로 보존한다.

### 2.3 절대 변경하지 않을 경계

1. Second Brain 기억은 JARVIS 명령의 실행 권한이 아니다.
2. JARVIS는 Second Brain Vault·SQLite를 직접 읽거나 쓰지 않는다.
3. Second Brain은 ORCA Worker를 생성하거나 종료하지 않는다.
4. ORCA의 `done` 문구나 prompt 복귀만으로 완료를 확정하지 않는다.
5. JARVIS AuthorityDb와 Second Brain DB를 합치지 않는다.
6. Mac에 JARVIS authority 또는 별도 Second Brain authority를 만들지 않는다.
7. raw terminal 전체 출력과 키 입력을 Second Brain에 저장하지 않는다.
8. 검증되지 않은 agent summary를 장기기억의 확정 사실로 쓰지 않는다.

### 2.4 구현 전 해소해야 할 Memory Authority 충돌

과거 운영 기록에는 `wiki-spike`의 `second-brain-operational-authority-adapter`가 존재하고, 현재 JARVIS Personal OS 계획은 `/home/jm/orca/projects/second-brain-app`을 production Second Brain provider로 지정한다. 두 경로를 동시에 장기기억 정본으로 운영하면 안 된다.

`Joint R0`에서 다음 중 하나를 증거로 확정해야 한다.

1. `second-brain-app`이 `wiki-spike`의 승인된 후속/추출 런타임이며 기존 authority를 대체한다.
2. `wiki-spike`가 실제 장기기억 backend이고 `second-brain-app`은 UI/adapter일 뿐이다.
3. 두 프로젝트가 별도 역할을 갖되, 장기기억 write authority는 한 곳으로만 고정된다.

확정 전 금지:

- 두 Vault에 동시 write
- 동일 ORCA/JARVIS 사건을 양쪽에서 ingest
- 서로 다른 conflict/correction/forget 정본 운영
- JARVIS가 두 memory provider를 자동 fallback으로 사용

필수 ADR: `ADR-JOINT-001 Durable Memory Authority`.

---

## 3. Source of Truth 매트릭스

| 데이터 | 권위 있는 시스템 | Second Brain 저장 여부 |
| --- | --- | --- |
| ORCA terminal 현재 상태 | ORCA live API | 직접 저장하지 않음 |
| task·dispatch·worker·terminal·worktree 상관관계 | JARVIS AuthorityDb | 검증된 최종 요약만 저장 |
| approval request·receipt·claim·settlement | JARVIS ControlPlane | digest/reference만 저장 가능 |
| command exit code·duration·bounded result | JARVIS observation/evidence | 장기 가치가 있을 때 요약 |
| worker progress | JARVIS progress/timeline | 최종 결과에 필요한 핵심만 |
| independent verification | JARVIS | 검증 결과와 evidence ref 저장 |
| 실패·해결 연결 | JARVIS | 해결된 교훈 또는 미해결 중요 문제 저장 |
| 개인 원칙·장기 결정·해결법 | Second Brain | 정본 |
| Wiki page·citation·conflict·forget | Second Brain | 정본 |
| Daily Control Loop run | JARVIS | evening closeout 중 장기 가치가 있는 항목만 |
| portfolio·project live state | JARVIS live connector | snapshot 전체를 장기기억으로 저장하지 않음 |
| 장기 이벤트 아카이브 | 선택적 Unified DB | 중복 ingest 방지 ID 필수 |

---

## 4. 사용자 중심 최종 경험

사용자는 대부분 ORCA 안에서 개발한다. 따라서 별도 shell logger 사용법을 익히게 해서는 안 된다.

### 4.1 ORCA 작업 시작

```text
사용자: second-brain-app 문제 고쳐줘
  ↓
JARVIS: 목표·프로젝트·승인 범위 확인
  ↓
ORCA task / dispatch / worktree / terminal 생성
  ↓
JARVIS가 동일 correlation_id로 모든 ID 연결
```

연결 대상:

```text
project_id
work_id
recommendation_id
task_id
dispatch_id
terminal_id
terminal_incarnation_id
worktree_id
agent_session_id
progress_id
verification_id
```

### 4.2 작업 중

ORCA 이벤트와 Worker evidence가 JARVIS에 들어간다.

```text
command 시작/종료
exit code
cwd / project / branch
변경 파일
테스트 결과
ask / escalation / decision gate
worker_done
```

에이전트는 의미 있는 결정만 JARVIS Agent Bridge에 checkpoint로 남긴다.

```text
작업 목적
설계 결정
중요 실패 원인
검증 결과
다음 단계
```

### 4.3 작업 실패

명령 하나가 실패해도 전체 작업을 바로 실패로 확정하지 않는다.

```text
pytest exit 1
  → Failure F-001 open
코드 수정
pytest exit 0
  → Resolution R-001 links F-001
  → F-001 resolved
```

최종 작업 결과:

```text
명령 실패: 존재
미해결 실패: 0
독립 검증: pass
전체 outcome: success
```

### 4.4 작업 종료

JARVIS가 증거를 확인해 terminal/work closeout을 만든다.

```text
무엇을 하려 했나
실제로 무엇을 했나
어떤 결과가 나왔나
어떤 실패가 있었나
어떻게 해결했나
무엇이 미완료인가
commit / PR / Issue / artifact는 무엇인가
다음 작업과 개선점은 무엇인가
```

### 4.5 장기기억 저장

JARVIS가 closeout 전체를 무조건 Second Brain에 쓰지 않는다.

```text
closeout
  → Memory Candidate 분류
  → 중요도·민감도·보존·충돌·확정 수준 판정
  → 필요 시 사용자 승인
  → outbox
  → Second Brain write request
  → Second Brain compile/reindex
  → 예상 artifact digest 관찰
  → JARVIS settlement
```

### 4.6 다음 작업 세션

새 ORCA 세션에서 JARVIS는 다음을 함께 사용한다.

```text
JARVIS AuthorityDb: 현재 상태, 미해결 작업, 승인, live terminal
Second Brain: 과거 결정, 해결법, 사용자 원칙, 검증된 closeout
```

이 조합으로 다음 질문에 답한다.

```text
어제 mail-intelligence에서 무엇을 했나?
실패한 테스트는 무엇이고 해결됐나?
이전에 같은 인증 오류를 어떻게 해결했나?
오늘 먼저 해야 할 작업은 무엇인가?
```

---

## 5. Mac과 jm-cloud 운영 구조

### 5.1 권위 있는 런타임

```text
jm-cloud
├─ ORCA server-side environment
├─ JARVIS AuthorityDb / ControlPlane / scheduler / dashboard
├─ Second Brain provider / vault / index / backup
└─ optional Unified DB
```

### 5.2 Mac 역할

```text
Mac
├─ ORCA client 및 Mac-local Worker terminals
├─ OMP/Luna
├─ Claude Code
├─ Codex
├─ JARVIS Control Center client
└─ Second Brain native capture/search client
```

Mac이 꺼져도 다음은 계속 동작해야 한다.

- JARVIS live monitoring
- Second Brain refresh와 backup
- jm-cloud ORCA Worker
- Daily Control Loop
- memory outbox reconciliation
- pending notification intent

### 5.3 Mac ORCA 관측

Mac의 일반 shell history를 먼저 훅킹하지 않는다. 1차 경로는 ORCA의 정식 상태와 lifecycle 이벤트다.

```text
Mac ORCA
  → terminal/worktree/task/dispatch/progress events
  → Tailscale/private channel
  → jm-cloud JARVIS connector
```

### 5.4 jm-cloud ORCA 관측

```text
jm-cloud ORCA
  → local connector
  → JARVIS AuthorityDb
```

Mac과 jm-cloud는 `host_id`, `environment_id`, `terminal_incarnation_id`로 구분한다.

---

## 6. MCP 구조 재설계

모든 에이전트가 하나의 MCP에 모든 책임을 몰아넣지 않는다. **두 개의 명확한 MCP 경계**를 사용한다.

### 6.1 JARVIS Agent Bridge MCP

운영·작업 상태와 의미를 다룬다.

제안 도구:

```text
jarvis_current_context
jarvis_terminal_context
jarvis_checkpoint
jarvis_record_failure
jarvis_record_resolution
jarvis_finish_work
jarvis_project_activity
jarvis_unresolved_failures
jarvis_decision_queue
```

이 MCP는 다음을 할 수 없다.

- 승인 receipt 자체 생성
- 승인 없이 workflow 실행
- Second Brain Vault 직접 수정
- Git push/merge/deploy 자동 승인

### 6.2 Second Brain MCP

장기기억을 다룬다.

현재 도구:

```text
sb_search
sb_read_page
sb_recent_changes
sb_open_conflicts
sb_remember
sb_run
```

운영 정책:

| 도구 | 모든 에이전트 사용 | 조건 |
| --- | --- | --- |
| `sb_search` | 허용 | read-only |
| `sb_read_page` | 허용 | bounded read |
| `sb_recent_changes` | 허용 | read-only |
| `sb_open_conflicts` | 허용 | read-only |
| `sb_remember` | 제한 허용 | 사용자의 명시적 “기억해” 또는 승인된 capture |
| `sb_run` | 제한 허용 | 명시적 quick-capture 즉시 처리; 외부 실행 권한 없음 |

자동 terminal closeout 저장은 일반 에이전트가 `sb_remember`로 직접 하지 않는다. JARVIS memory outbox를 사용한다.

### 6.3 에이전트별 동작

```text
OMP/Luna ─┬─ jarvis MCP: 현재 작업/실패/승인/체크포인트
          └─ second-brain MCP: 과거 지식 검색/명시적 기억

Claude ───┬─ jarvis MCP
          └─ second-brain MCP

Codex ────┬─ jarvis MCP
          └─ second-brain MCP
```

Mac에서는 SSH/Tailscale을 통해 jm-cloud MCP를 실행하고, jm-cloud에서는 로컬 stdio로 실행한다.

---

## 7. 터미널 작업 데이터 모델

### 7.1 JARVIS AuthorityDb에 추가할 운영 엔티티

#### `terminal_sessions`

```text
terminal_id
terminal_incarnation_id
host_id
environment_id
terminal_provider
started_at
ended_at
status
primary_project_id
created_by
```

#### `terminal_project_segments`

한 terminal에서 `cd` 또는 ORCA worktree 변경으로 프로젝트가 바뀌는 구간을 기록한다.

```text
segment_id
terminal_id
project_id
worktree_id
cwd_digest
started_at
ended_at
resolution_source
resolution_confidence
```

#### `terminal_events`

```text
event_id
terminal_id
sequence
kind
occurred_at
started_at
finished_at
duration_ms
exit_code
outcome
command_class
command_digest
stdout_digest
stderr_digest
evidence_ref
redaction_state
```

#### `terminal_agent_sessions`

```text
agent_session_link_id
terminal_id
agent_platform
agent_session_id
model_id
started_at
ended_at
```

#### `terminal_failures`

```text
failure_id
terminal_id
project_id
source_event_id
failure_class
summary
status
opened_at
resolved_at
resolution_id
severity
```

#### `terminal_resolutions`

```text
resolution_id
failure_id
source_event_ids
summary
verification_id
verified_at
```

#### `terminal_closeouts`

```text
closeout_id
work_id
terminal_ids
project_ids
outcome
verified_result
failed_items
unresolved_items
artifacts
commit_refs
issue_refs
improvements
next_actions
canonical_digest
signed_at
```

### 7.2 Second Brain에 저장할 장기기억 계약

`TerminalWorkSummaryV1`:

```yaml
schema: terminal-work-summary-v1
memory_candidate_id: memcand_...
jarvis_closeout_id: closeout_...
jarvis_receipt_digest: sha256:...
project_id: second-brain-app
host_scope: [mac-client, jm-cloud]
terminal_count: 2
started_at: ...
finished_at: ...
outcome: success
verified: true

purpose: ...
work_performed: [...]
verified_results: [...]
failures:
  - failure_id: ...
    summary: ...
    status: resolved
    resolution: ...
artifacts: [...]
commits: [...]
issues: [...]
improvements: [...]
next_actions: [...]
source_refs: [...]
```

Second Brain에는 다음을 저장하지 않는다.

- 전체 stdout/stderr
- 키 입력
- private reasoning
- secret 원문
- 모든 중간 heartbeat
- 단기적인 prompt 복귀/idle 상태

---

## 8. 프로젝트 판별과 correlation

### 8.1 프로젝트 판별 우선순위

1. JARVIS가 만든 task의 명시적 `project_id`
2. ORCA dispatch/worktree metadata
3. 등록된 `workername`
4. canonical worktree root
5. Git remote + root
6. cwd path mapping
7. 판단 불가 시 `unassigned`

### 8.2 금지된 판별 방식

- terminal title 문자열만 사용
- agent가 “이 프로젝트다”라고 말한 prose만 사용
- 현재 prompt의 디렉터리 표시만 사용
- branch 이름만 사용

### 8.3 한 터미널의 다중 프로젝트

```text
13:00-14:10 second-brain-app
14:10-14:30 mail-intelligence
14:30-15:00 second-brain-app
```

위처럼 segment를 나누고 primary project는 시간·task·effect 비중과 명시적 task association으로 결정한다.

---

## 9. 작업 완료와 실패 판정

### 9.1 명령 상태

```text
succeeded
failed
cancelled
timeout
uncertain
skipped
```

### 9.2 failure 상태

```text
open
investigating
resolved
accepted-risk
superseded
invalidated
```

### 9.3 work 최종 outcome

```text
success
partial
failed
cancelled
blocked
uncertain
```

### 9.4 `success` 최소 증거

- valid task/dispatch/work correlation
- expected artifact 존재
- 요구된 test/lint/build 증거
- 독립 verifier 또는 정책상 동등한 검증
- open P0/P1 failure 0 또는 명시적 accepted-risk receipt
- uncertain non-idempotent effect 0

### 9.5 성공으로 인정하지 않는 것

- agent의 “완료했습니다” 문장
- terminal prompt 복귀
- ORCA active_work=0 단독
- Git working tree가 clean이라는 사실 단독
- exit code 0 하나만 존재

---

## 10. 개선점 도출 책임

### 10.1 JARVIS가 도출하는 운영 개선

- 반복 실패
- 반복 수동 명령
- 장기 dirty worktree
- verification 누락
- 승인 대기 병목
- 중복 Worker
- stale terminal
- 불필요한 polling
- 과도한 model/token 사용
- 동일 장애의 반복 해결

### 10.2 Second Brain이 보존하는 개선 지식

- 재사용 가능한 해결법
- 프로젝트 운영 원칙
- 승인된 architectural decision
- 반복적으로 유효한 runbook
- 장기적인 기술 부채와 개선 방향

### 10.3 GitHub Issue 생성

```text
JARVIS finding
  → Issue draft
  → 사용자 승인
  → GitHub Issue 생성
  → issue_id를 JARVIS와 Second Brain summary에 연결
```

사용자 승인 없이 issue를 생성하지 않는다.

---

## 11. 기존 JARVIS Personal OS 계획과의 통합

이 계획은 JARVIS Personal OS 계획을 대체하지 않는다. 다음 todo를 terminal memory 관점에서 확장한다.

| JARVIS 기존 Todo | Terminal Work Memory 통합 내용 |
| --- | --- |
| 2 | source-of-truth에 terminal observation/closeout/memory 경계 추가 |
| 3 | terminal command/output redaction·retention·pause 정책 추가 |
| 6 | 실제 Second Brain 1.0의 6개 MCP 도구 및 schema 재기준화 |
| 7 | terminal observation/closeout persistence 추가 |
| 8 | memory candidate/outbox와 terminal closeout correlation 추가 |
| 9 | TerminalObservationV1, TerminalCloseoutV1 계약 추가 |
| 10 | supervised Second Brain transport 유지 |
| 11 | memory read adapter 유지 |
| 12 | Second Brain 및 terminal ingestion health 추가 |
| 13 | ORCA terminal source registry 추가 |
| 14 | ORCA terminal/worktree/task observations를 주 수집 경로로 확장 |
| 15-18 | terminal evidence를 context/recommendation에 bounded input으로 사용 |
| 20-24 | Daily Control Loop와 Today UI에 terminal closeout·unresolved failure 노출 |
| 26 | task/dispatch/terminal/worktree/session/progress/verification correlation 강화 |
| 27 | verified closeout 기반 memory candidate 분류 |
| 28-30 | Second Brain write request/outbox/reconciliation 사용 |
| 31-33 | JARVIS UI에 terminal timeline·failure·improvement, Mac 알림 추가 |
| 36 | Mac off, jm-cloud restart, ORCA reconnect, SB offline 복구 검증 |

### 11.1 반드시 재검토할 기존 계획 drift

현재 JARVIS 계획은 Second Brain MCP를 “기존 5개 도구”로 기술한다. 현재 `second-brain-app`은 `sb_run`까지 포함한 6개 도구를 제공하므로 compatibility fixture를 다시 고정해야 한다.

또한 현재 Second Brain 기준선은 과거 `master` commit이 아니라 `release/second-brain-1.0.0` 계열의 실제 설치판과 맞춰 재측정해야 한다.

### 11.2 Daily Control Loop 제약

사용자가 JARVIS 개발 완료를 알리기 전에는 Daily Control Loop를 독립적으로 시작하지 않는다.

Terminal Work Memory는 먼저 ORCA event correlation과 closeout 계약을 준비하고, 실제 morning/in-day/evening loop 연결은 JARVIS 핵심 계약·authority·recovery가 검증된 뒤 진행한다.

---

## 12. 재기획된 단계별 개발 순서

독립적인 Second Brain 1.1.0 Terminal Capture Core 계획을 폐기하고 아래 joint release train을 사용한다.

## Joint R0 — 계획·기준선·계약 정렬

### 목적

두 저장소가 같은 아키텍처와 실제 버전을 기준으로 개발을 시작한다.

### 작업

1. JARVIS personal OS plan을 현재 Linux·ORCA·Second Brain 1.0 기준으로 fresh review
2. JARVIS와 Second Brain clean task worktree 생성
3. 현재 MCP 도구·schema·오류 fixture export
4. ORCA host/environment/project ID canonicalization
5. TerminalObservationV1, TerminalCloseoutV1, MemoryCandidateV1 계약 작성
6. 권한·보존·redaction 정책 고정
7. 이전 standalone Terminal Work Memory 계획을 superseded로 표시
8. `second-brain-app`과 `wiki-spike` 중 durable memory write authority를 ADR로 단일 확정

### 완료 기준

- cross-repo contract digest 일치
- UNKNOWN authority edge 0
- Mac/jm-cloud host matrix 확정
- 프로덕션 code edit 전 baseline test 모두 기록
- JARVIS 계획 fresh approval 전 구현 시작 금지
- memory authority 중복 0

---

## Joint R1 — ORCA-first Terminal Observation

### 목적

사용자가 실제로 사용하는 ORCA 작업을 별도 shell hook 없이 JARVIS가 정확히 관측한다.

### JARVIS 작업

- terminal/session/project segment migrations
- ORCA readonly connector 확장
- Mac와 jm-cloud environment 구분
- task/dispatch/worktree/terminal correlation
- event dedup·cursor·incarnation 처리
- bounded command outcome 및 evidence reference
- terminal health/capability

### ORCA 의존 계약

- terminal ID
- worktree ID
- task ID
- dispatch ID
- agent session ID
- worker_done/escalation/ask/decision gate
- progress/verification evidence

### Second Brain 작업

없음. 이 단계에서 raw/live terminal을 Second Brain에 쓰지 않는다.

### 완료 기준

- Mac ORCA terminal 2개와 jm-cloud terminal 2개가 충돌 없이 구분됨
- project 이동 segment 정확도 100% fixture
- duplicate/reordered event가 중복 effect를 만들지 않음
- raw secret·전체 terminal output persistence 0

---

## Joint R2 — Verified Work Closeout

### 목적

한 terminal 또는 여러 terminal이 수행한 한 작업을 검증 가능한 closeout으로 만든다.

### 작업

- failure/resolution state machine
- command failure와 work outcome 분리
- verifier result correlation
- commit/PR/Issue/artifact linkage
- unresolved blocker와 accepted risk
- improvement finding
- next action
- `jarvis_finish_work` agent bridge
- crash/restart 후 closeout resume

### 완료 기준

- 실패→수정→검증 성공 chain 재구성
- agent “done”만으로 closeout 성공 불가
- 동일 work에 closeout 하나
- 여러 terminal/worktree를 한 work에 연결 가능
- open P0/P1가 있으면 success 금지

---

## Joint R3 — Durable Memory Candidate & Second Brain Settlement

### 목적

검증된 작업 중 장기 가치가 있는 내용만 Second Brain에 저장한다.

### JARVIS 작업

- candidate classifier
- sensitivity/purpose/retention/confirmation
- memory outbox
- uncertain write reconciliation
- expected artifact digest settlement

### Second Brain 작업

- `TerminalWorkSummaryV1` write request 수신
- candidate/closeout/receipt/idempotency fields
- collision-safe request inbox
- citation·source reference 검증
- compile 후 artifact digest 제공
- correction/forget/export compatible history

### 완료 기준

- 동일 candidate 반복 전송 시 artifact 1개
- response 유실 시 JARVIS가 uncertain/reconciling 유지
- artifact 관찰 전 settled 금지
- conflict가 기존 지식을 덮어쓰지 않음
- 민감/inferred 정보는 요구된 승인 없이 확정되지 않음

---

## Joint R4 — 모든 에이전트 MCP 및 사용자 UI

### 목적

Mac과 jm-cloud의 OMP/Luna, Claude Code, Codex가 동일한 운영 상태와 장기기억을 사용한다.

### 작업

- JARVIS Agent Bridge MCP 배포
- Second Brain MCP read/capture profile 배포
- host별 stdio/SSH launcher 생성
- OMP/Claude/Codex global registration health
- JARVIS Today/Terminal/Failure/Improvement UI
- Second Brain 앱은 capture/search/file sync/briefing 역할 유지
- 두 앱 deep link 또는 명확한 전환 링크

### UI 소유권

| 화면 | 소유 앱 |
| --- | --- |
| NOW/BLOCKED/DECISIONS/NEXT 3 | JARVIS |
| Worker/terminal/worktree timeline | JARVIS |
| 실패·해결·승인·Issue draft | JARVIS |
| 빠른 기억·파일 업로드·폴더 sync | Second Brain Mac app |
| 장기지식 검색·page·conflict | Second Brain app 및 JARVIS Memory view |
| 원본 Vault 직접 탐색 | 제공하지 않음 |

### 완료 기준

- 3개 agent × 2 host에서 두 MCP health 통과
- Mac 에이전트와 jm-cloud 에이전트가 같은 work/memory 조회
- direct SB memory write와 JARVIS approved write가 출처로 구분됨
- JARVIS control 권한이 SB MCP 연결만으로 부여되지 않음

---

## Joint R5 — Non-ORCA Shell Fallback

### 목적

ORCA 밖에서 수행한 중요한 일반 zsh/bash 작업도 선택적으로 기록한다.

### 우선순위

이 단계는 ORCA-first 경로가 안정화된 뒤 진행한다. 사용자의 대부분 개발이 ORCA이므로 초기 핵심 경로가 아니다.

### 작업

- zsh preexec/precmd metadata hook
- bash DEBUG/PROMPT_COMMAND metadata hook
- command class, exit code, duration, cwd, git context
- local Unix socket collector
- Mac offline spool
- Tailscale 재연결 후 sync
- `SB_NO_CAPTURE=1` 또는 JARVIS capture pause
- secret redaction corpus
- ORCA session과 중복 시 dedup/merge

### 완료 기준

- hook p95 지연 10ms 이하
- network loss 후 event loss 0, duplicate logical event 0
- password/secret/keystroke 저장 0
- ORCA와 shell collector가 같은 명령을 이중 기록하지 않음

---

## Joint R6 — Daily Control Loop 연결

### 시작 조건

- JARVIS core authority와 recovery 검증 완료
- 사용자 “JARVIS 개발 완료” 통지 또는 명시적 시작 승인
- R1-R4 완료

### 연결 내용

Morning:

- 어제 verified closeout
- 미해결 failure
- 현재 ORCA live state
- Second Brain 사용자 원칙과 과거 해결법
- 최대 NEXT 3

In-day:

- 새로운 blocker
- verification fail
- approval request
- 반복 장애
- stale terminal/worktree

Evening:

- verified completions
- failed/incomplete reasons
- memory candidates
- improvement findings
- tomorrow first action

### 완료 기준

- Second Brain unavailable 시 honest degraded mode
- Mac off 상태에서도 jm-cloud loop 계속 동작
- JARVIS가 SB pipeline을 직접 실행하지 않고 refresh 결과를 관찰
- 사용자 명시적 quick capture의 `sb_run`과 scheduled refresh가 충돌하지 않음

---

## 13. 기능 요구사항

### Architecture

| ID | 요구사항 |
| --- | --- |
| REQ-JOINT-ARCH-001 | ORCA, JARVIS, Second Brain의 권한 경계를 분리해야 한다. |
| REQ-JOINT-ARCH-002 | JARVIS AuthorityDb와 Second Brain 저장소를 합치지 않아야 한다. |
| REQ-JOINT-ARCH-003 | Mac은 authority host가 아니어야 한다. |
| REQ-JOINT-ARCH-004 | JARVIS는 Second Brain을 MCP 계약으로만 사용해야 한다. |
| REQ-JOINT-ARCH-005 | Second Brain 기억은 실행 승인으로 사용되지 않아야 한다. |

### ORCA correlation

| ID | 요구사항 |
| --- | --- |
| REQ-ORCA-001 | task, dispatch, terminal, worktree, agent session을 하나의 work로 연결해야 한다. |
| REQ-ORCA-002 | Mac과 jm-cloud terminal identity가 충돌하지 않아야 한다. |
| REQ-ORCA-003 | terminal incarnation과 stale event를 구분해야 한다. |
| REQ-ORCA-004 | 한 terminal의 프로젝트 전환을 segment로 기록해야 한다. |
| REQ-ORCA-005 | `worker_done`만으로 완료를 확정하지 않아야 한다. |

### Terminal evidence

| ID | 요구사항 |
| --- | --- |
| REQ-TWM-001 | command outcome, exit code, duration, bounded evidence를 기록해야 한다. |
| REQ-TWM-002 | command failure와 work outcome을 분리해야 한다. |
| REQ-TWM-003 | failure와 resolution을 evidence로 연결해야 한다. |
| REQ-TWM-004 | commit, PR, Issue, artifact, verification을 closeout에 연결해야 한다. |
| REQ-TWM-005 | crash/restart 후 closeout을 재개할 수 있어야 한다. |

### Memory settlement

| ID | 요구사항 |
| --- | --- |
| REQ-MEM-001 | verified outcome 또는 explicit user instruction만 확정 memory 후보가 될 수 있어야 한다. |
| REQ-MEM-002 | memory write는 idempotency key와 expected artifact digest를 가져야 한다. |
| REQ-MEM-003 | Second Brain artifact 관찰 전 JARVIS outbox를 settled로 만들지 않아야 한다. |
| REQ-MEM-004 | conflict는 자동 덮어쓰지 않아야 한다. |
| REQ-MEM-005 | correction/forget/export가 receipt와 history를 보존해야 한다. |

### MCP

| ID | 요구사항 |
| --- | --- |
| REQ-MCP-001 | 모든 agent가 Mac과 jm-cloud에서 Second Brain read 도구를 사용할 수 있어야 한다. |
| REQ-MCP-002 | 모든 agent가 JARVIS current context와 terminal checkpoint를 사용할 수 있어야 한다. |
| REQ-MCP-003 | MCP 연결만으로 실행 권위가 생기지 않아야 한다. |
| REQ-MCP-004 | `sb_remember`는 explicit capture와 JARVIS outbox provenance를 구분해야 한다. |
| REQ-MCP-005 | interrupted write는 자동 재실행하지 않고 uncertain reconciliation을 사용해야 한다. |

### Security

| ID | 요구사항 |
| --- | --- |
| REQ-SEC-TERM-001 | 키 입력과 password prompt를 수집하지 않아야 한다. |
| REQ-SEC-TERM-002 | secret-bearing command와 output은 저장 전 마스킹해야 한다. |
| REQ-SEC-TERM-003 | raw output 크기와 retention을 제한해야 한다. |
| REQ-SEC-TERM-004 | 사용자가 host/terminal/project별 capture를 중지할 수 있어야 한다. |
| REQ-SEC-TERM-005 | private reasoning을 수집하지 않아야 한다. |

### Operations

| ID | 요구사항 |
| --- | --- |
| REQ-OPS-JOINT-001 | Mac이 꺼져도 jm-cloud JARVIS와 Second Brain이 동작해야 한다. |
| REQ-OPS-JOINT-002 | Second Brain 장애가 JARVIS authority를 중단시키지 않아야 한다. |
| REQ-OPS-JOINT-003 | ORCA reconnect와 out-of-order event를 복구해야 한다. |
| REQ-OPS-JOINT-004 | cross-repo contract drift를 doctor가 탐지해야 한다. |
| REQ-OPS-JOINT-005 | backup/restore 후 correlation과 memory settlement가 보존돼야 한다. |

---

## 14. 보안·개인정보 정책

### 14.1 수집 금지

- keystroke stream
- password prompt input
- private key, API token, cookie 원문
- `.env`, `.ssh`, Keychain contents
- hidden chain of thought/private reasoning
- 전체 화면·audio·video
- 무제한 stdout/stderr

### 14.2 저장 등급

| 등급 | 내용 | 기본 보존 |
| --- | --- | --- |
| ephemeral | live heartbeat, transient prompt state | 짧은 TTL 또는 비저장 |
| operational | task/terminal/progress/failure evidence | JARVIS 정책 기간 |
| durable-candidate | verified closeout 후보 | 승인/분류 전 JARVIS outbox |
| durable-memory | 확정 원칙·결정·해결법·closeout summary | Second Brain 정책 |

### 14.3 redaction 시점

```text
수집 전 1차 command redaction
→ JARVIS ingestion boundary 2차 schema validation
→ evidence persistence 전 3차 secret classifier
→ Second Brain candidate 전 purpose/sensitivity filter
```

---

## 15. 테스트 및 적대적 검증

### 15.1 계약 테스트

- Python Second Brain fixture export
- TypeScript JARVIS fixture import
- canonical JSON SHA-256 일치
- tool/schema/error drift fail closed

### 15.2 ORCA E2E

1. Mac ORCA task 생성
2. jm-cloud ORCA task 생성
3. 동일 project, 다른 host terminal 구분
4. one work에 multiple terminal 연결
5. worker crash 후 resume
6. duplicate `worker_done`
7. stale terminal incarnation
8. verifier reject 후 재작업

### 15.3 Memory saga E2E

```text
verified closeout
→ candidate
→ approval when required
→ write request
→ response loss
→ reconcile
→ artifact observed
→ settled
```

실패 시나리오:

- Second Brain offline
- MCP protocol drift
- duplicate candidate
- changed expected digest
- compile failure
- conflict
- JARVIS crash after send
- lost response
- timeout before artifact
- restore from backup with pending outbox

### 15.4 보안 E2E

- command에 Bearer token 포함
- `.env` cat 시도
- malicious terminal title
- prompt injection in tool output
- memory page가 “이 명령을 실행하라”고 지시
- wrong host/project identity
- forged JARVIS receipt
- agent가 직접 authority field 주입

모두 실행 권위 상승과 secret persistence가 0이어야 한다.

### 15.5 Mac 실기 검증

- OMP/Luna + JARVIS MCP + Second Brain MCP
- Claude Code + 두 MCP
- Codex + 두 MCP
- Tailscale 단절/복구
- Mac sleep/wake
- JARVIS Control Center terminal timeline
- Second Brain native app capture/search
- 알림 deep link

---

## 16. 성능 목표

| 항목 | 목표 |
| --- | --- |
| ORCA event ingest p95 | 200ms 이하, LLM 제외 |
| JARVIS context 조회 p95 | 500ms 이하 |
| terminal checkpoint p95 | 300ms 이하 |
| shell fallback hook p95 | 10ms 이하 |
| duplicate logical event | 0 |
| lost verified closeout | 0 |
| unauthorized authority effect | 0 |
| secret plaintext persistence | 0 |
| same candidate duplicate memory | 0 |

---

## 17. Migration 및 rollback

### 17.1 JARVIS

- forward-only checksummed migration
- 기존 AuthorityDb 백업 후 clone migration test
- terminal tables는 기존 task/progress/verification FK를 참조
- rollback은 schema를 역변환하지 않고 이전 compatible binary 또는 capability unavailable 사용

### 17.2 Second Brain

- write request schema versioning
- old `terminal_summary` JSONL connector는 historical import compatibility로 유지
- production 새 terminal summary는 JARVIS outbox 경로 사용
- 기존 page/ledger와 충돌하지 않는 idempotency key

### 17.3 cross-repo commit 실패

한 저장소 commit 성공 후 다른 저장소 commit이 실패하면 첫 저장소에 revert commit을 만들고 증거를 남긴다. 반쪽짜리 contract pair를 유지하지 않는다.

---

## 18. 기존 기능과의 호환

### 18.1 `records_orca.py`의 `terminal_summary`

현재 기능은 제거하지 않는다. 역할을 다음처럼 제한한다.

- 과거 Orca export 기록 import
- 외부 시스템에서 이미 확정된 terminal summary ingest
- 신규 실시간 authority 경로로 사용하지 않음

신규 운영 경로는:

```text
ORCA live event → JARVIS verified closeout → Second Brain write request
```

### 18.2 Unified DB

Unified DB를 쓰는 경우 JARVIS settled event를 append-only archive로 export할 수 있다. 그러나 Second Brain이 ORCA raw와 Unified DB export를 동시에 ingest해 같은 사건을 중복 기억하지 않도록 `global_event_id`와 provenance를 유지한다.

### 18.3 Second Brain native app

기존 기능을 유지한다.

- 빠른 기억
- 파일 upload
- 폴더 sync
- 검색
- 브리핑

terminal 운영 관제와 approval UI를 중복 구현하지 않는다. 해당 기능은 JARVIS Control Center가 소유한다.

---

## 19. 위험과 대응

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| JARVIS와 SB가 같은 terminal 데이터를 이중 저장 | 불일치·중복 | operational vs durable 경계 고정 |
| ORCA event schema 변화 | correlation 중단 | versioned fixture/digest/doctor |
| agent가 checkpoint를 누락 | 의미 부족 | ORCA 사실 기반 closeout + finish gate |
| terminal raw output에 secret 포함 | 정보 유출 | pre-ingest redaction + bounded evidence |
| Mac 단절 | 관측 지연 | JARVIS cursor/reconnect, optional spool |
| SB offline | memory settlement 지연 | outbox reconciling, JARVIS 계속 운영 |
| duplicate worker/terminal | 중복 effect | primary executor + idempotency + incarnation |
| plan drift | 두 프로젝트 충돌 | joint traceability and cross-repo review |
| UI 중복 | 사용자 혼란 | JARVIS=운영, SB=기억/수집 역할 고정 |
| Daily Loop 조기 개발 | 재작업 | JARVIS core 완료 승인 전 시작 금지 |

---

## 20. 구현 순서와 저장소별 책임

### 첫 구현 배치

1. JARVIS plan fresh review 및 현재 Second Brain 1.0 rebaseline
2. cross-repo contract fixture 갱신
3. JARVIS source-of-truth 및 privacy 문서
4. JARVIS terminal migrations/contracts
5. ORCA observation adapter
6. correlation/failure/closeout
7. JARVIS Agent Bridge MCP
8. verified memory candidate
9. Second Brain write request contract
10. outbox reconciliation
11. JARVIS terminal UI
12. generic shell fallback
13. 사용자 승인 후 Daily Control Loop 연결

### 저장소별 첫 코드 위치

#### Orca-JARVIS

```text
src/terminal-contracts.ts
src/terminal-observations.ts
src/terminal-correlation.ts
src/terminal-closeout.ts
src/terminal-failures.ts
src/jarvis-agent-mcp.ts
migrations/032_personal_context.sql 또는 재번호화된 신규 migration
migrations/033_personal_operations.sql 또는 재번호화된 신규 migration
```

#### second-brain-app

```text
sb/write_requests.py
sb/contracts.py
sb/mcp.py
sb/connectors/inbox_documents.py
sb/compile.py
```

Second Brain 변경은 R3 전까지 최소화한다.

---

## 21. 계획 승인 Gate

구현 시작 전 다음이 명시적으로 승인돼야 한다.

- [ ] ORCA=실행면, JARVIS=통제면, Second Brain=장기기억 경계
- [ ] raw/live terminal은 JARVIS, verified durable summary는 Second Brain
- [ ] ORCA-first, generic shell hook은 후순위
- [ ] Mac client-only, jm-cloud authority
- [ ] 모든 agent에 JARVIS MCP와 Second Brain MCP 동시 제공
- [ ] direct `sb_remember/sb_run`은 명시적 capture 용도, 자동 terminal closeout은 JARVIS outbox 사용
- [ ] Daily Control Loop는 JARVIS 완료 승인 후 연결
- [ ] JARVIS Control Center가 terminal/failure/approval UI를 소유
- [ ] Second Brain app은 capture/search/file sync/briefing 역할 유지
- [ ] `second-brain-app` 대 `wiki-spike` durable memory authority를 ADR-JOINT-001로 단일 확정

---

## 22. 전체 완료 정의

완료 후 JARVIS는 다음 질문에 live evidence와 memory citation을 구분해 답해야 한다.

```text
지금 Mac과 jm-cloud에서 어떤 ORCA 작업이 실행 중인가?
어제 second-brain-app에서 어떤 terminal들이 무엇을 했나?
실패한 명령은 무엇이고 어떤 검증으로 해결됐나?
아직 해결되지 않은 P0/P1는 무엇인가?
해당 해결 방법은 과거 어느 작업에서 사용했나?
이 결과 중 어떤 내용이 Second Brain 장기기억으로 확정됐나?
왜 오늘 이 작업을 NEXT 1로 추천했나?
```

Second Brain은 다음 질문에 출처와 함께 답해야 한다.

```text
이 프로젝트의 고정 방향은 무엇인가?
이전에 동일한 인증 오류를 어떻게 해결했나?
지난 작업에서 검증된 결과와 개선점은 무엇인가?
어떤 기억이 충돌 중이며 어느 closeout에서 왔나?
```

최종 성공 조건:

```text
ORCA가 실행한 사실을 JARVIS가 정확히 관측하고
JARVIS가 승인·검증·실패/해결을 통제하며
검증된 장기 가치만 Second Brain에 정착되고
Mac과 jm-cloud의 모든 에이전트가 같은 운영 상태와 기억을 사용한다.
```

---

## 23. 현재 판정

```text
JARVIS↔Second Brain 통합 방향: 존재
JARVIS↔Second Brain 실제 구현: 미완료
독립 Terminal Work Memory 계획: 경계 수정 필요
새 joint 계획: 본 문서로 재정의
코드 구현: 아직 시작하지 않음
Daily Control Loop: 사용자 완료 통지 전 시작 금지
```
