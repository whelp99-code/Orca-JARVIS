# Second Brain refresh receipt — 계약 제안과 인계 bundle (2026-09-11)

**전달 상태: 미전송.** 이 문서는 파일로 준비했을 뿐이고 provider 작업공간에 어떤 변경도 하지 않았다.
상대 저장소의 진행 중 파일을 덮어쓰지 않았다.

## 1. 판독 결과 — 지금 없는 것

| 확인 | 값 |
|---|---|
| provider 소스 checkout | `/home/jm/orca/projects/second-brain-app` (존재) |
| 설치된 release | `/home/jm/.local/state/second-brain/app/current` → `releases/41f0751aca8906d612961e704bc60dd0855fdabd` |
| 실행 파일 | `bin/second-brain-mcp`, `bin/sb` (둘 다 실행 가능) |
| 설정 | `/home/jm/.config/second-brain/config.toml` (존재) |
| refresh receipt 스키마 | **없음.** `docs/planning/daily-refresh-publication-contract.md:36-37`이 “provider측 receipt 스키마와 endpoint는 합의 대상”이라고 기록 |
| refresh 관련 profile/schema 검색 | `rg` 매치 **0** (src, contracts 전체) |
| 기존 동결 profile | `task32-schema4`, `remember-schema5`, `cancellation-schema6`, `cancellation-submit-schema7`, `scoped-record-read-v1…v5`, `scoped-request-status-v1`, `scoped-request-write-v1` |
| 기존 status가 주는 것 | request, scope, provider instance, proof, generation, tombstone fence |
| 기존 status에 없는 것 | **cap/완전성 결과, release identity, refresh 완료 시각** |

즉 JARVIS가 daily에서 요구하는 “이번 refresh가 언제 끝났고, 잘렸는지, 어느 release가 만들었는지”를
현재 계약으로는 알 수 없다. 기존 scoped status로 대체하면 **없는 사실을 있는 것처럼 쓰는 것**이 된다.

## 2. JARVIS측에서 이미 끝낸 것

| 항목 | 위치 |
|---|---|
| 버전 협상 | `src/second-brain-refresh-receipt.ts` `ACCEPTED_REFRESH_PROFILES` — 동결하지 않은 profile은 이름을 들어 거절 |
| fail-closed 파서 | 같은 파일: 심볼릭 링크 거부, 8,192 byte 상한, bounded strict JSON, 닫힌 envelope(`schema_version`/`profile`/`receipt`) |
| 거절 사유 기록 | `lastOutcome()` — `unconfigured` / `unreadable(absent·not_a_regular_file·too_large)` / `unsupported(profile·envelope)` / `received` |
| 제품 상태 연결 | `jarvis daily morning --once`의 `provider_refresh`가 **저장된 `refresh_context` 단계**에서 나온다. 상수 `"unavailable"`을 제거했다 |
| 설정 입력 | morning: `schema_version: 2` + `refresh_receipt_path`; evening/service: `schema_version: 2` + `refresh: { receipt_path }`. 버전 1 레코드는 그대로 닫혀 있다 |
| 계약 회귀 | `tests/integration/second-brain-refresh-receipt.test.ts` 6케이스 |

JARVIS는 receipt를 **그대로 통과시키고 분류는 제품 규칙**(`evaluateRefreshContext`)에 맡긴다. 어댑터가
성공을 합성하지 않는다는 뜻이며, provider가 아무것도 내지 않으면 `refresh_missing`이 유지된다.

## 3. provider에 요청하는 변경

### 3.1 발행 위치

release가 자기 상태 파일을 쓰는 디렉터리에 한 파일을 추가로 발행한다. 경로는 운영자가 정하고 JARVIS
설정에 절대경로로 넣는다. 예: `/home/jm/.local/state/second-brain/refresh-receipt.json`.

### 3.2 envelope (JARVIS가 받는 정확한 형태)

```json
{
  "schema_version": 1,
  "profile": "daily-refresh-receipt-v1",
  "receipt": {
    "schema_version": 1,
    "refresh_id": "refresh:2026-08-30:1",
    "state": "completed",
    "completed_at": "2026-08-30T22:14:30.000Z",
    "protocol_version": 1,
    "capped": false
  }
}
```

- envelope 키는 정확히 세 개다. 추가 키는 거절된다(`unsupported/envelope`).
- `receipt`는 JARVIS의 기존 `RefreshCompletion`(`src/daily-loop-types.ts:35-42`)과 동일하다. 새 타입을
  만들지 않았다.
- `state`는 `completed` 또는 `failed`. `protocol_version`이 1이 아니면 JARVIS는
  `refresh_incompatible`로 분류한다.
- `capped: true`는 `refresh_capped`로 분류되어 brief가 기권한다. **잘린 결과를 정상 빈 결과로 바꾸지
  않는다.**
- `completed_at`이 미래이거나 `refresh_freshness_ms`보다 오래되면 `refresh_stale`이다.
- 파일 전체는 8,192 byte 이하, 일반 파일이어야 한다(심볼릭 링크 거부).

### 3.3 아직 합의가 필요한 필드

다음은 §8.1이 요구하지만 위 최소 envelope에는 **일부러 넣지 않았다.** 임의로 넣으면 기존 닫힌 요청에
필드를 추가하는 것이 되기 때문이다. provider가 제공 가능 여부를 답하면 `daily-refresh-receipt-v2`로
협상한다.

| 필드 | 왜 필요한가 |
|---|---|
| `release_identity` | build 완료와 published/activated 구분 (§8.1.3) |
| `scope_digest` / `request_id` | refresh ↔ scoped request 매핑 (§8.1.2) |
| `generation` / `manifest_digest` | 같은 권한 fence 아래 active manifest 대조 |
| `completeness` | cap 외의 부분 완전성 |

### 3.4 오류·호환 규칙

- 알 수 없는 `profile`: JARVIS가 거절하고 `unsupported/profile`로 기록한다. provider는 profile을
  올릴 때 이전 profile 발행을 최소 한 주기 유지한다.
- 파일 부재: 정상 상태다. JARVIS는 `refresh_missing`으로 남긴다. 빈 파일이나 `null`을 쓰지 않는다.
- 실패한 refresh: 파일을 지우지 말고 `state: "failed"`로 발행한다. 그래야 “실패”와 “없음”이 구분된다.
- 서명: 이 profile은 서명을 요구하지 않는다. 서명 범위가 필요하면 v2에서 `signature`와 정확한 서명
  대상 바이트를 함께 정의한다. **로컬 hash 일치를 서명으로 표현하지 않는다.**

## 4. 실행 가능한 격리 harness

provider 없이 양측 계약을 시험하는 방법은 이미 저장소에 있다.

```bash
cd /home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui
npm run build:backend
npm run test:integration -- tests/integration/second-brain-refresh-receipt.test.ts
```

이 테스트는 파일 상단에 **CONTRACT TEST**로 표시돼 있고, 여기의 fake receipt는 실제 provider 통과로
세지 않는다.

## 5. 상대 산출물이 도착하면 실행할 것

1. provider release가 §3.2 형태를 발행하는지 실제 파일로 확인한다.
2. 그 절대경로를 daily 설정 `schema_version: 2`의 `refresh_receipt_path`(morning) 또는
   `refresh.receipt_path`(evening/service)에 넣는다.
3. `jarvis daily morning --once --db <db> --input <config>` 실행 후 `provider_refresh`가 `fresh`인지,
   저장된 `refresh_context` 단계가 같은 `refresh_id`를 갖는지 확인한다.
4. cap·stale·실패·profile 변경을 각각 발행해 `capped`/`stale`/`failed`/`unavailable`이 나오는지
   확인한다.
5. §3.3 필드가 합의되면 `ACCEPTED_REFRESH_PROFILES`에 v2를 추가하고 파서를 확장한다. profile 추가는
   계약 변경이므로 코드 변경 없이 설정만으로 열리지 않는다.

## 6. 통과 기준

- provider가 §3.2를 발행하고, 위 3–4가 모두 관측되면 M4.1 refresh 연결은 완료로 판정할 수 있다.
- §3.3이 합의되기 전까지 “generation build 완료”와 “published/activated”의 구분은 **미충족**으로
  남는다. 이 문서는 그 미충족을 완료로 바꾸지 않는다.
