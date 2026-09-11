# 로컬 관측 retention 운영안 (개발 제안, 미적용)

이 문서는 개발 구현이 끝난 retention lane을 운영자가 검토하기 위한 제안이다. **여기의 어떤 명령도
운영 환경에서 실행하지 않았고, 운영 설정·서비스·DB를 바꾸지 않았다.** 적용 여부는 운영자 결정이다.

## 1. 무엇이 구현됐는가

| 단계 | 모듈 | 계약 |
|---|---|---|
| 선정 | `src/local-observation-retention-selection.ts` | 설정 `{schema_version:1, retain_ms}`로 cutoff를 정하고 참조 중인 그룹은 보류한다. 쓰기 없음 |
| 적용 | `src/local-observation-retention.ts` | 원본을 snapshot으로 고정한 뒤 그 snapshot에서만 복사·검증한다 |
| 후보 검증 | `src/local-observation-retention-candidate.ts` | 복사기 자신의 plan을 실행해 후보와 양방향 대조한다 |
| 운영 기록 | `migrations/089_local_retention_operations.sql` | operation ID·source identity/세대·선정 digest·candidate 소유 증거·단계를 내구성 있게 남긴다 |
| 교체 | `src/local-observation-retention-swap.ts` | quiesce lease 안에서 적용 기록을 후보에 먼저 쓰고 rename한다 |
| 복구 | `src/local-observation-retention-recovery.ts` | 소유가 증명된 자기 산출물만 정리하고, 증명되지 않으면 보존·보고한다 |
| 일정 | `src/local-observation-retention-service.ts` + `migrations/090_local_retention_cycle_fence.sql` | 무설정=inactive, runtime 없음=unsupported, 창 밖=deferred, 미완료 잔여=blocked |

## 2. 설정 예시 (개발 값, 운영 값 아님)

```json
{"schema_version": 1, "retain_ms": 2592000000}
```

`retain_ms` 허용 창은 `[300000, 31536000000]`ms이며 알 수 없는 키·다른 버전·범위 밖·비정수는 모두
`LOCAL_RETENTION_CONFIG_INVALID`로 거절한다. 스케줄 간격은 코드 인자 `interval_ms`이며 허용 창은
`[60000, 86400000]`ms다. 이 두 값은 서로 다른 레코드이고, 스케줄 값을 cutoff 설정 문서에 넣지 않는다.

제안 근거: 30일(`2592000000`)은 관측 cache의 실효 수명이며, 감사·참조 보존 규칙이 먼저 적용되므로
참조 중인 그룹은 이 창을 넘겨도 삭제되지 않는다. 운영 적용 전에 아래 미리보기로 실제 선정량을 본다.

## 3. 운영자 검토용 명령 (읽기 → 적용 → 복구)

```bash
# 1. 읽기 전용 미리보기: 무엇이 선정되는지만 본다. 쓰기 없음.
jarvis timeline retention-preview <config.json> --db <authority.sqlite> --json

# 2. 적용은 서비스 주기로만 수행한다. 단발 CLI 적용 명령은 의도적으로 만들지 않았다.
#    적용 경로는 quiesce lease·세대 재확인·fd 확인을 거치므로 runtime을 통해서만 호출된다.

# 3. 복구는 급사 후 재기동 시 주기 시작에서 자동 수행된다. 수동 점검은 기록 조회로 한다.
sqlite3 <authority.sqlite> \
  "SELECT operation_id,state,failure_code,candidate_path,result_generation FROM local_retention_operations ORDER BY created_at;"
```

증명되지 않은 후보 파일은 삭제하지 않고 `retained_unproven`으로 보고하며, 그 주기는 `blocked`로
멈춘다. 이 상태의 해소는 운영자가 파일의 정체를 판단한 뒤 결정한다.

## 4. 반복 주기 실측 (개발 fixture, `scripts/measure-local-retention-capacity.mjs 4`)

| round | observations | audit_events | operations | main bytes | wal bytes | cycle_ms | rss bytes |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 2,908,160 | 4,309,552 | - | - |
| 1 | 1 | 1 | 1 | 4,382,720 | 0 | 1564 | 125423616 |
| 2 | 1 | 2 | 2 | 4,382,720 | 0 | 1610 | 125902848 |
| 3 | 1 | 3 | 3 | 4,382,720 | 0 | 1563 | 124698624 |
| 4 | 1 | 4 | 4 | 4,382,720 | 0 | 1704 | 125501440 |

읽는 법: 관측 cache는 주기마다 1건 유입·1건 제거로 평형을 이루고 main 파일은 재구축 뒤
4,382,720 bytes에서 더 늘지 않는다. 반면 **감사 행과 운영 기록은 주기마다
단조 증가**한다. 즉 retention이 정상 동작해도 전체 용량은 계속 증가할 수 있으며, 이는 결함이 아니라
불변 이력 보존의 결과다. 용량을 맞추려고 감사 행을 지우지 않는다.

## 5. 운영 적용 전 남은 결정 (운영자 몫)

1. 실제 `retain_ms`와 `interval_ms` 값 확정.
2. retention lane을 어느 서비스 프로세스의 주기에 붙일지 결정. 현재 구현은 호출자가 runtime을
   제공할 때만 교체를 수행하고, 제공하지 않으면 `unsupported`로 보고한다.
3. `blocked` 상태 해소 절차(증명되지 않은 후보 파일 처리)의 운영 책임자 지정.
