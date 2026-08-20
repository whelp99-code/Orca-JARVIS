# Budgeted Evolution Shadow MVP

## 상태

이 기능은 현재 **내부 shadow 평가기**다.

- production 실행 결과는 항상 기존 실행기가 결정한다.
- budgeted evolution은 production 결과를 바꾸지 않는다.
- package root `src/index.ts`에서 공개하지 않는다.
- Control Plane, ApprovedCommandExecutor, dashboard, CLI에 연결하지 않는다.
- candidate 자동 승격과 production routing은 구현하지 않는다.

따라서 이 단계에서 관측 데이터 손실은 학습 품질만 낮출 수 있다. production 성공을 실패로 바꾸거나 새로운 실행 권한을 만들 수 없다.

## 실행 흐름

```text
BudgetedTask
  -> productionExecutor
  -> canonical production result
  -> BudgetedEvolutionEngine shadow run
     -> complete capability match
     -> Fast / Slow / Lab candidate selection
     -> candidate execution
     -> cheap verification
     -> bounded evaluation
     -> append-only performance observation
  -> optional observation sink
  -> production result + optional shadow result/failure metadata
```

Shadow engine 또는 observation sink가 실패하면 `EvolutionShadowRuntime`은 production 결과와 함께 다음 failure stage를 데이터로 반환한다.

- `engine`: candidate 실행, 검증, 평가 또는 budget 실패
- `sink`: shadow 결과는 생성됐지만 observation sink 기록 실패

`productionExecutor` 자체의 실패만 canonical 실패로 전파한다.

## 단일 엔진

MVP는 `BudgetedEvolutionEngine` 하나만 유지한다.

이전 `EvolutionaryAIEngine`의 병렬 후보 실행·consensus 구현은 제거했다. 공통 DTO와 error contract는 `src/evolution-contracts.ts`로 분리했다.

### Routing path

| Path | 사용 조건 | 후보 수 |
|---|---|---:|
| Fast | 신뢰 가능한 champion, drift/novelty/risk 없음 | 1 |
| Slow | challenger sampling, novelty, drift, champion 없음 | policy와 task cap 중 작은 값 |
| Lab | high risk 또는 `forceLab` | policy와 task cap 중 작은 값 |

후보는 `requiredCapabilities`를 **전부** 충족해야 한다. 일부만 충족하는 후보는 routing 대상이 아니다.

## Fail-closed contract

다음 조건은 `EvolutionEngineError`의 machine-readable code로 실패한다.

- `ENGINE_NO_CAPABLE_CANDIDATE`
- `ENGINE_INVALID_BUDGET`
- `ENGINE_RESULT_IDENTITY_MISMATCH`
- `ENGINE_INVALID_METRIC`
- `ENGINE_ALL_CANDIDATES_FAILED_VERIFICATION`
- `ENGINE_EVALUATION_BUDGET_EXHAUSTED`
- `ENGINE_EVALUATION_MISMATCH`
- `ENGINE_VERIFICATION_MISMATCH`
- `ENGINE_NO_RESULTS`

Executor가 반환한 candidate ID는 선택된 profile ID와 같아야 한다. Evaluator ID도 result ID와 같아야 한다. Cost, latency, evaluation score 입력은 유한값이어야 하며 cost와 latency는 음수가 될 수 없다.

Cheap verifier에서 탈락한 candidate도 실패 observation으로 남는다. 모든 candidate가 탈락하면 consensus 없이 종료한다.

## Performance memory

Migration은 `migrations/029_budgeted_evolution_shadow.sql`이다. 기존 `028_negative_evidence.sql`은 변경하지 않는다.

`evolution_shadow_observations`는 append-only 테이블이다.

- observation마다 UUID primary key를 생성한다.
- task key, candidate ID, candidate configuration fingerprint를 기록한다.
- outcome은 `verified` 또는 `verification_failed`다.
- score, cost, latency, created_at을 기록한다.
- UPDATE와 DELETE는 trigger가 거부한다.

Champion summary는 저장 시 갱신하지 않고 조회 시 집계한다. 이 구조는 여러 memory instance가 기록할 때 read-modify-upsert로 observation을 잃는 문제를 제거한다.

Candidate fingerprint는 ID, kind, 정렬된 capabilities, cost/latency/risk weight의 canonical JSON을 SHA-256으로 계산한다. 같은 candidate ID라도 설정이 바뀌면 과거 champion 기록을 재사용하지 않는다.

## 권한 경계

`ImprovementProposal.requiresApproval`은 메타데이터일 뿐 실행 권한이 아니다.

이번 MVP에는 다음 기능이 없다.

- candidate 설정 변경
- champion production 승격
- prompt 또는 workflow 자동 수정
- Control Plane command 생성
- 승인 receipt 발급 또는 소비

향후 production promotion을 추가하려면 별도의 typed `evolution.promote` action, signed receipt, claim/fence, ApprovedCommandExecutor 경로를 먼저 구현해야 한다.

## 검증

### Focused tests

```bash
npx vitest run --no-file-parallelism \
  tests/unit/budgeted-evolution-engine.test.ts \
  tests/unit/budgeted-evolution-adversarial.test.ts \
  tests/unit/evolution-shadow-runtime.test.ts \
  tests/integration/budgeted-evolution-memory.test.ts \
  tests/integration/migrations.test.ts \
  tests/unit/public-api.test.ts
```

### Built-module smoke

```bash
npm run build
node scripts/budgeted-evolution-smoke.mjs --scenario sqlite
node scripts/budgeted-evolution-smoke.mjs --scenario shadow
```

SQLite scenario는 migration 028과 029 공존, append row 수, reopen champion, temp directory cleanup을 확인한다. Shadow scenario는 engine과 sink 실패 모두에서 production 결과가 유지되는지 확인한다.
