# JARVIS Task Timeline

상태: 구현 완료 / Buzz는 UX 참고 사례로만 사용

## 1. 제품 경계

Orca-JARVIS는 협업 메신저가 아니다. 여러 Orca·AI Agent의 작업을 관찰하고, 사람 승인 후 실행하며, 결과를 검증하는 AgentOps Control Plane이다.

Buzz에서 가져오는 것은 다음 사용자 경험 하나다.

> 하나의 작업 화면에서 사람의 요청, Agent 진행, 승인 요청, 실행 결과, 검증 증거를 시간순으로 함께 본다.

별도 Room, Identity, Membership, Message Store, Buzz Bridge는 JARVIS의 제품 범위가 아니다.

## 2. 정본 데이터

Task Timeline은 새로운 메시지 DB를 만들지 않는다. 다음 기존 정본을 읽기 전용으로 합성한다.

- `work_items`, `event_ledger`, `audit_facts`
- `control_command_requests`, 승인 영수증, 실행 effect, `control_events`
- `workflow_runs`, `workflow_steps`, `workflow_transitions`
- `gjc_intents`, `gjc_intent_events`, `gjc_questions`
- `verification_evidence`
- `progress_observations`, `progress_projection`
- `live_supervisor_bindings`

따라서 Timeline을 삭제해도 실행 상태나 승인 기록은 손실되지 않는다. Timeline은 정본이 아니라 Projection이다.

## 3. 사용자 화면

한 작업을 열면 다음 순서로 표시한다.

```text
사용자 요청
JARVIS 작업 분해
Planner/Implementer/Reviewer/Verifier 진행
승인 요청
사용자 승인 또는 거절
승인된 명령 실행
테스트·검증 결과
완료 또는 복구 경로
```

예시:

```text
08:10  사용자          기능 개발 요청
08:12  JARVIS          Workflow 시작
08:15  Planner         계획 완료
08:40  Implementer     코드 변경 완료
08:43  Verifier        전체 테스트 통과
08:44  JARVIS          Git push 승인 대기
```

## 4. 승인 원칙

Timeline에 표시된 메시지·Agent 주장·Workflow 출력은 실행 권한이 아니다.

모든 변경·실행은 계속 다음 경로를 따른다.

```text
Control Command 요청
→ 사람의 Ed25519 단일 사용 승인 영수증
→ 명령·대상·인자·만료·fence 재검증
→ Approved Executor 실행
→ effect와 검증 결과 기록
```

Task Timeline은 읽기 전용이다. `timeline list`, `timeline show`, `timeline context`는 명령을 실행하거나 DB 상태를 변경하지 않는다.

## 5. 작업 식별

Timeline은 다음 ID를 하나의 작업 단위로 묶는다.

- `work_items.id`
- `control_command_requests.request_id`
- `workflow_runs.correlation_id`
- `workflow_runs.run_id`
- `gjc_intents.continuation_id`
- `gjc_intents.intent_id`

Control Command의 `target.task_id`, `target.work_id`, `target.correlation_id`, `args.task_id`, `args.work_id`, `args.correlation_id`가 존재하면 해당 상위 작업 Timeline에 합쳐진다.

## 6. CLI

```bash
# 최근 작업 목록
jarvis timeline list --db .jarvis-runtime/jarvis.sqlite

# 특정 작업의 전체 진행 기록
jarvis timeline show <task-id> --db .jarvis-runtime/jarvis.sqlite

# Agent 또는 Action Hub에 전달할 제한된 Context Capsule
jarvis timeline context <task-id> \
  --limit 100 \
  --max_bytes 131072 \
  --db .jarvis-runtime/jarvis.sqlite
```

## 7. Context Capsule

Context Capsule에는 다음만 포함한다.

- 작업 요약
- 최근 Timeline 이벤트
- 현재 승인 대기
- 연결된 Worker
- 검증 증거 목록

기본 최대 크기는 128KiB다. 크기를 초과하면 오래된 이벤트부터 제외하고 `truncated:true`로 표시한다. 과거 전체 대화나 터미널 transcript는 포함하지 않는다.

## 8. 폐기된 Collaboration Workspace

Migration `025_collaboration_workspace.sql`은 운영 DB에 이미 적용됐으므로 수정하거나 삭제하지 않는다.

Migration `026_task_timeline.sql`이 다음을 수행한다.

- `collaboration-workspace`를 `task-timeline`으로 대체했다고 기록
- Collaboration Identity·Room·Membership·Event·Buzz Bridge 신규 쓰기 차단
- 기존 행이 있다면 보존
- Timeline 조회용 인덱스 추가

기존 Collaboration CLI와 Approved Executor action은 제거됐다. Capability는 다음처럼 보고한다.

```json
{
  "task_timeline": true,
  "collaboration_workspace": false,
  "buzz_bridge": false
}
```

## 9. Buzz와의 관계

Buzz는 사람과 Agent가 같은 작업 맥락을 보는 UX 참고 사례다. JARVIS 내부에 Buzz 서버·Nostr 신원·채널 권한·메시지 저장소를 구현하지 않는다.

향후 Buzz 또는 다른 UI를 붙이더라도 다음 읽기 전용 API만 사용한다.

- Task 목록
- Task Timeline
- Context Capsule
- 승인 대기 카드

외부 UI가 승인 또는 실행 권한의 정본이 되는 것은 금지한다.

## 10. 인수 기준

- Timeline이 기존 정본 데이터만 읽는다.
- Timeline 조회로 DB mutation이 발생하지 않는다.
- 대기 승인이 작업 Timeline에 표시된다.
- Workflow step과 evidence digest가 같은 Timeline에 표시된다.
- 기존 Collaboration 신규 쓰기는 fail-closed 된다.
- Migration 025 checksum이 변경되지 않는다.
- 전체 `npm run verify`가 exit 0이다.
