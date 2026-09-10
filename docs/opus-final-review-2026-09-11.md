# 31514bd 최종 회신 재검증 — 2026-09-11

## 판정

**R1의 기존 재현 차단, R3의 유지보수 쓰기 계약, R4의 프로세스 매트릭스는 확인했다. R2는 다른 원본을 받아들이는 추가 재현이 남아 있어 전체 수정 완료로 인수하지 않는다.** 운영 교체나 자동 접수 활성화 전에 R2를 수정한다.

대상은 `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, branch `codex/routing-approval-ui`, HEAD `31514bdc958c056707bfdd866c0c9d209e90064d`다. 이 리뷰는 제품 파일을 변경하지 않았고 격리 QA 파일과 테스트만 실행했다. Opus의 최종 회신 원문은 `docs/opus-fix-final-reply-2026-09-11.md`에 보존한다.

## 확인된 결과

| 구간 | 직접 확인 |
|---|---|
| 기존 R1 원본 `/./` 별칭 | LOCAL_RETENTION_DESTINATION_INVALID, 원본 존재 및 digest 동일 |
| 기존 R1 기존 목적지 | 동일 오류로 거절, 목적지 덮어쓰기 없음 |
| 기존 R2 선정 후 notification 추가 | LOCAL_RETENTION_SOURCE_CHANGED로 거절 |
| R3 원본 쓰기 | WAL 20,632→0 bytes, main DB hash 변경, total_changes 105→105. 계약대로 유지보수 쓰기 존재 |
| R4 프로세스 매트릭스 | 직접 대상 실행 exit 0, 1파일/8테스트, 10.91초 |
| 전체 verify 로그 | backend 275파일/1,885 + 275파일/1,911, dashboard 38파일/263 = 588파일/4,059테스트; acceptance 결과 확인 |
| gate 이후 제품 변경 | src/scripts/migrations/package/tsconfig 비교 변경 0개 |
| 리뷰 중 원본 변경 | src/scripts/tests/migrations 1,433파일 hash 비교 변경 0개 |

R4의 정상 경로는 compiled 테스트 진입점이 고정 시계를 주입하는 자식 프로세스이며, 제품 바이너리 자체는 invalid config 거절을 확인하는 범위다. 실제 assembler/producer 완료와는 구분한다. 이 범위는 Opus 최종 회신에도 명시돼 있다.

현재 빌드 metadata는 `52db87d`의 입력 digest `sha256:89e6ccc6ab682945a8b212af76fb535d1098f7dabb5faed3deb9318c8318d2e2`를 가리킨다. 현재 입력과 다른 파일은 capped가 추가된 `tests/integration/daily-morning-cli-process.test.ts` 1개다. 그 파일만 52db87d의 내용으로 되돌린 **메모리상 파일 벡터**가 metadata digest와 정확히 일치했다. 파일을 실제로 되돌리거나 다시 빌드하지 않았다. 따라서 제품 코드 변경이 없어 전체 gate를 반복하지 않았다는 설명은 확인한 범위에서 맞다.

## R2 추가 발견 — P1: 행 수 일치가 원본 내용 일치를 보장하지 않음

위치:
- `src/local-observation-retention.ts:143` — assertCandidateMatchesSelection
- `src/local-observation-retention.ts:33` — retentionSourceFence
- `src/local-observation-retention.ts:77` — verifyLocalObservationRetentionCandidate

현재 검사는 6개 표의 COUNT(*)를 비교한다. 열린 SQLite 연결이 읽는 파일과 현재 source.filename이 가리키는 파일이 다를 때, 행 수만 같으면 내용 차이를 잡지 못한다. device/inode도 열린 연결의 파일이 아니라 현재 pathname을 stat한 값이다.

독립 compiled 재현 순서:
1. 정상 AuthorityDb로 원본을 열어 migrate하고, gjc_intents에 한 행을 넣는다. 원본 journal mode는 WAL이다. payload_json은 `{"marker":"selected-source"}`다.
2. 별도 경로에 같은 스키마/같은 행 수의 DB를 준비한다. 이 DB의 payload_json은 `{"marker":"different-content"}`이고 journal mode는 DELETE로 설정한다. **원본 연결은 WAL 그대로 유지한다.**
3. 별도 DB를 닫고, apply 호출 **전에** 그 파일을 원본 pathname으로 rename한다. 원본 연결은 이전 파일을 계속 읽는다.
4. 새 목적지로 applyLocalObservationRetention을 호출하고, 반환값을 verifyLocalObservationRetentionCandidate에 넘긴다.

실측:

| 관측 | 결과 |
|---|---|
| 원본 연결에서 읽은 payload | `{"marker":"selected-source"}` |
| 생성된 후보에서 읽은 payload | `{"marker":"different-content"}` |
| apply 오류 | null, 성공 반환 |
| 후보 재검증 | 통과 |
| gjc_intents 행 수 | 원본 1 / 후보 1 |
| 나머지 비교 5개 표 | 원본 0 / 후보 0 |

선정은 이전 파일을 읽고 후보는 다른 내용의 파일을 복사했는데도 인수되는 경우다. 원본과 대체 파일이 모두 WAL인 대조군에서는 LOCAL_RETENTION_SOURCE_CHANGED로 차단됐다. **이번 새 재현 조건에는 DELETE 모드 대체 파일이 포함된다.** 이 조건을 숨기거나 WAL→WAL에서도 동일하게 성공했다고 보고하지 않는다. 현재 API는 해당 파일 교체를 안전하게 거절하지 못하므로 일반적인 원본 일치 보장은 아직 성립하지 않는다.

이전 리뷰 스크립트의 네 케이스가 통과한 것은 그대로 인정한다. 그 결과를 모든 원본 교체 경우의 검증으로 확대할 수는 없다. 신규 재현은 전용 임시 DB만 사용했고 후보를 운영 원본으로 교체하지 않았다.

## 즉시 후속 작업 지시

1. R2를 재개한다. 위 WAL 원본→DELETE 대체 파일, 같은 행 수/다른 내용 케이스를 회귀 테스트로 추가한다. 최초 실패를 확인하고 수정 후 apply 또는 후보 재검증이 확실히 거절하는지 기록한다.
2. 선정과 복사를 **같은 열린 연결의 일관된 snapshot**에 결속하거나, 열린 연결이 읽는 실제 파일과 복사 대상의 동일성을 검증한다. COUNT(*)는 내용의 증거로 사용하지 않는다. 원본 pathname의 stat와 그 파일의 hash만 서로 비교해도 열린 연결과의 결속은 해결되지 않는다.
3. 지원하지 않는 journal mode가 있다면 명시적으로 거절하고 문서화한다. 다만 mode 검사만 붙여 이번 입력을 막은 것을 모든 파일 동일성 문제의 해결이라고 주장하지 않는다. 행 수가 같은 다른 행 ID/내용, 다른 테이블 내용, 호출 전후 교체를 함께 검증한다.
4. 실패 시 원본·이미 존재하는 파일을 보존하고, 해당 호출 소유의 후보만 정리한다. 기존 R1 및 notification interleaving 회귀를 유지한다.
5. 수정 후 retention 관련 테스트와 필요한 공유 builder 회귀를 실행한다. 제품 코드가 바뀌므로 통합 시점 전체 verify를 1회 수행하고 고정된 입력/RC/종료 시각을 저장한다.
6. 독립 재검토를 수행하는 경우 수정된 R2 전체와 이전 지적을 대상에 포함한다. capped 테스트만 검토한 APPROVE를 R2 전체 승인으로 사용하지 않는다. 이 리뷰에서 별도 에이전트를 새로 실행하지는 않았다.

기존 작업 지시서 `docs/opus-work-instructions-2026-09-10.md`의 원본 snapshot, 의미상 참조, 교체 전 재검증 요구는 유지한다. 실제 운영 swap 프로토콜은 여전히 별도이며, 이 수정에 운영 DB 교체나 재시작은 필요하지 않다.

## 증거 기록에서 정정할 두 항목

- `gate-review.md`의 3차는 `2673e4a`의 **capped 프로세스 케이스로 범위가 제한**돼 있다. 해당 APPROVE는 실제이며 8/8 시험도 기록돼 있으나, 52db87d의 R2 전체를 독립 재검토했다는 증거는 아니다. 회신서에 승인 범위를 정확히 적는다.
- `verify-receipts.json`에는 pre-fix verify5의 RC 0과 a9358d5에서 시작한 중간 실행의 `pending`만 있다. `verify-final.log`의 종료 receipt는 없고, 실패/중단된 중간 실행도 상태 정리가 안 돼 있다. 전체 verify exit 0은 Opus가 전달한 결과로 접수하되, 원래 세션의 최종 RC와 종료 시각을 해당 run에 연결해 receipt를 갱신한다. 리뷰어가 소유하지 않은 monitor의 종료 코드를 임의 생성하지 않는다.

이 두 문서 문제 때문에 기존 테스트 성공을 실패로 바꾸지는 않는다. 이번 인수 보류의 제품상 이유는 위 R2 재현이다.

## 재현 및 증거 위치

`/home/jm/.cache/jarvis-final-review-20260911`:
- `reproduce.mjs`, `reproduce-result.json` — 원본 리뷰 스크립트 사본으로 기존 네 케이스 재실행. 원본 증거는 보존.
- `equal-count-source.mjs`, `equal-count-source-result.json` — WAL/WAL 및 DELETE/DELETE 비교.
- `mixed-journal-source.mjs`, `mixed-journal-source-result.json` — WAL/DELETE 및 DELETE/WAL 재현, 각 비교 표의 원본/후보 행 수 포함.
- `daily-process.log` — 현재 프로세스 매트릭스 8/8, 직접 실행 RC 0.
- `build-identity.json`, `gate-input-comparison.json` — artifact 일치와 gate 이후 입력 차이 대조.
- `review-before.json`, `review-result.json` — 리뷰 대상 SHA와 파일 hash 변화 측정.

재현 명령: `node /home/jm/.cache/jarvis-final-review-20260911/mixed-journal-source.mjs`.
이 스크립트는 관찰값을 출력하는 재현 도구이므로, 종료 코드 0을 제품 수정 성공으로 해석하지 않는다. 성공 기준은 내용이 다른 후보의 거절과 원본 보존이다.
