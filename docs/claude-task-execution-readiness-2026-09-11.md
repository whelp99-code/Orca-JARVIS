# 업무 실행자 준비 상태와 운영 적용안 (개발 제안, 미적용)

**실제 업무를 실행하지 않았다.** 이 문서는 실행에 필요한 것과 지금 없는 것을 실측으로 적고, 운영자가
검토할 적용·rollback 절차를 준비한다. 비밀 값은 포함하지 않는다. 아래 모든 값은 이름·존재 여부·오류
코드뿐이며 환경 변수 내용이나 키 바이트를 출력하지 않았다.

## 1. 지금 상태 (실측, `node dist/src/cli.js routing probe-runtime claude-code`)

| 항목 | 값 |
|---|---|
| 등록 | `registration: "registered"` — 등록된 실행자는 `claude-code` 하나 |
| 실행 가능 | `execution_available: false` |
| readiness | `not_probed` |
| 설정 | `configuration: "missing"` |
| 없는 설정 | `JARVIS_TASK_CLAUDE_PATH`, `JARVIS_TASK_VERIFIER_KEY_PATH`, `JARVIS_TASK_VERIFIER_KEY_ID` |
| 인증 probe | `state: "not_probed"`, `reason_code: "TASK_AUTH_PROBE_NOT_CONFIGURED"`, `remote_verification: "not_performed"` |
| 측정 시각 | `2026-09-11T02:05:43.813Z` |

이 상태에서 승인된 업무를 실행하면 `TASK_EXECUTOR_CONFIGURATION_MISSING` →
`TASK_EXECUTION_NOT_CONFIGURED`로 fail-closed다. 즉 **지금은 어떤 경로로도 실제 실행이 일어나지
않는다.** 로그 원본은 `/home/jm/.cache/jarvis-m6-20260911/executor-readiness.log`.

## 2. 설정 manifest (이름과 검증 규칙만)

| 키 | 검증 규칙 | 실패 코드 |
|---|---|---|
| `JARVIS_TASK_CLAUDE_PATH` | 절대경로, `realpath` 해석 가능, 일반 파일, group/other 쓰기 불가(`mode & 0o022 === 0`), `X_OK` 실행 가능 | `TASK_PROVIDER_UNAVAILABLE` |
| `JARVIS_TASK_VERIFIER_KEY_PATH` | 절대경로이며 `realpath(path) === path`(정규 경로), 일반 파일, 현재 UID 소유, `mode & 0o077 === 0`, hard link 정확히 1, 크기 1–16,384 byte. 실행 권한은 요구하지 않음 | `TASK_VERIFIER_UNAVAILABLE` |
| `JARVIS_TASK_VERIFIER_KEY_ID` | 비어 있지 않음. 실행 시 이 key_id가 신뢰된·미폐기·Ed25519·purpose `verifier` 인 anchor 키로 해석되어야 하고, 그 anchor의 principal이 기대 verifier principal이 된다(상수로 고정되지 않음). decision 키와 바이트 공유 금지 | `TASK_CERTIFICATION_BINDING_INVALID` |

> `src/task-certification-context.ts`가 전에는 principal `independent-verifier`를 소스에 박아 두었다.
> sealed 배포의 anchored verifier가 principal `jm-verifier`(purpose `verifier`, Ed25519)이고
> sealing trigger가 키 추가를 금지하면, 그 이름은 어떤 방법으로도 만들 수 없어
> 인증이 영구히 거절됐다. 지금은 기대 principal을 `JARVIS_TASK_VERIFIER_KEY_ID`가 가리키는
> anchor 키에서 읽어오며, 해당 키가 없거나 폐기됐거나 purpose가 다르거나 Ed25519가
> 아니면 기존 `TASK_CERTIFICATION_BINDING_INVALID`로 fail-closed 거절한다. 핀이 없을 땐
> 요청된 키 자신이 anchor가 되고, 구조 검사는 그대로 적용된다.
>
> **핀을 강제하지 않는 경계(실제 시도 후 되돌림):** sealed DB에서 핀이 없으면
> 거절하는 규칙을 구현해 실제로 실행해 보았다. `initialize()`는 항상 sealing하고
> 기존 certification suite는 아무도 이 핀을 설정하지 않으므로, 78개 중 36개가 실패했다
> (`f2-trial.log`). 핀을 모든 fixture에 주입하는 것은 이 범위 밖이라 되돌렸다.
> 그러므로 지금은 sealed 여부를 보지 않는다: 핀이 없으면 상수 대신 요청된 키에서
> principal을 얻고, 운영은 핀을 설정해야 한다.
> `src/task-certification-proof.ts`·`src/task-independent-verifier.ts`·
> `src/authority-verification-store.ts`의 `independent-verifier` 바인딩은 이 변경 범위 밖이다.

세 값은 운영자만 제공할 수 있다. 개발에서 새 fixture 키를 만들어 이 자리에 넣는 것은 **운영 인증
증거가 아니며** 하지 않았다.

## 3. 적용 대상 업무 1건 (제안, 미승인)

기존 템플릿 `code-fix`를 사용한다. 새 실행 엔진을 만들지 않는다.

| 항목 | 값 |
|---|---|
| 템플릿 | `code-fix` (`tests/integration/task-templates.test.ts`가 covering) |
| 대상 | 이 저장소의 단일 파일 수정 1건 |
| 허용 파일 | TaskSpec `scope: declared_repository_files`에 명시한 경로만 |
| 허용 행동 | 파일 수정과 `verified_git_commit`. push·merge·배포 없음 |
| 예산 | plan 한계 내 `timeout_ms ≤ 600000`, 출력 ≤ 1,048,576 byte, prompt ≤ 524,288 byte |
| 성공 기준 | 승인 receipt → dispatch → native 실행 → 독립 verifier 서명 → `TaskCompletion` 저장까지 결속. 경로 probe나 exit 0만으로 완료를 선언하지 않음 |
| rollback | 생성된 commit을 `git revert`. 실행 전 HEAD를 기록하고 대조 |

## 4. 예상 쓰기와 외부 효과

- 로컬 authority DB: `control_command_requests`, dispatch/completion 행, 서명 receipt.
- 파일 시스템: sandbox(`/usr/bin/bwrap`, 빈 환경) 안의 후보 산출물과 승인 범위 파일.
- 외부 효과: **model API 호출 1회**(실행자 인증이 있을 때). 메일·견적·전송 등 다른 외부 행동은 없다.
- 중복 억제: 완료된 요청의 재생은 재실행 없이 replay된다(`idempotency:
  completed_request_replay_without_reexecution`). 이 성질은 fixture 회귀가 실측한다.

## 5. 사전 gate

1. `npm run verify` 통과 (최근 결과는 최종 회신서 §6.1).
2. `node dist/src/cli.js routing probe-runtime claude-code` → `configuration: "present"`,
   `readiness` 통과, `execution_available: true`.
3. `node dist/src/cli.js routing probe-executor claude-code` → 인증 `state`가 probe 가능.
4. 대상 TaskSpec의 plan digest를 운영자가 확인하고 승인 서명.

## 6. 적용 순서

1. 운영자가 세 환경 변수를 **service 환경**에 설정한다. 개발 셸과 운영 service 환경을 구분한다.
2. §5의 probe 2건을 실행해 값 없이 상태만 기록한다.
3. TaskSpec 1건을 staging → 승인 → dispatch 한다.
4. 실행 후 완료 receipt와 verifier 서명을 조회한다.
5. 결과를 기록하고, 성과 측정은 실제 receipt에 한해서만 집계한다. 청구 비용이 없으면 `unavailable`로
   표기하며 0원이나 절감률을 만들지 않는다.

## 7. health / readback

```bash
node dist/src/cli.js routing probe-runtime claude-code
node dist/src/cli.js routing executors
sqlite3 <authority.sqlite> "SELECT state,failure_code FROM control_command_requests ORDER BY created_at DESC LIMIT 5;"
```

## 8. rollback 조건과 명령

| 조건 | 행동 |
|---|---|
| 실행이 uncertain으로 끝남 | 재시도 금지. 기존 outbox/reconciliation 계약으로 상태를 확정한 뒤 결정 |
| 승인 만료·scope 변조·fence 불일치 | 실행하지 않음(제품이 거절). 설정 변경이 아니라 승인을 다시 받는다 |
| 산출 commit이 부적절 | `git revert <sha>` — 이 저장소에서, 운영자 지시로만 |
| 실행자 설정을 되돌림 | 세 환경 변수를 service 환경에서 제거하면 `TASK_EXECUTION_NOT_CONFIGURED`로 즉시 fail-closed 복귀 |

## 9. 이 문서가 주장하지 않는 것

- 실제 업무가 실행됐다고 주장하지 않는다. §1의 실측이 그 반대를 보여준다.
- fixture 키·mock provider·주입 시계로 통과한 회귀를 운영 인증 증거로 쓰지 않는다.
- 세 환경 변수를 개발에서 만들어 넣지 않았고, 넣을 것을 제안하지도 않는다. 값은 운영자 소유다.
