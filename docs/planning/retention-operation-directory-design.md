# Retention 산출물 격리와 교체 배타성 — 설계 노트 (미구현)

2차 독립 리뷰가 남긴 4건은 버그 넷이 아니라 설계 하나다. 이 문서는 그 단위를 그대로 집어 실행할 수
있게 범위를 고정한다. **아직 구현하지 않았다.**

## 1. 무엇이 열려 있나

| 열린 지적 | 현재 구조에서 왜 생기나 |
|---|---|
| 후보 digest 확인 ~ rename 사이 변조 | 후보가 공유 이름 공간에 있고, 확인과 설치가 두 동작이다 |
| 원본 마지막 읽기 ~ rename 사이 커밋 유실 | 교체 구간에 프로세스 간 writer 배타성이 없다 |
| 운영 행 기록 이전 claim 유실 | 두 경로를 확보한 뒤에야 행을 쓰므로, 그전 크래시는 행이 없어 복구가 모른다 |
| `.releasing` 중 크래시 고아 | 해제가 이름 옮기기 + 지우기 두 동작이다 |

공통점은 둘이다. **(a) 산출물이 남이 접근할 수 있는 이름 공간에 있다. (b) 교체 구간이 배타적이지 않다.**

## 2. 바꿀 것 — (a) 운영 전용 디렉터리

`applyLocalObservationRetention(source, cutoff, freshPath, now)`의 `freshPath`를 **파일 이름이 아니라
디렉터리 이름**으로 해석한다.

- 확보: `mkdirSync(freshPath, { mode: 0o700 })` — 이미 있으면 실패하므로 배타성은 지금의 `O_EXCL`과
  같고, 실패 코드도 `LOCAL_RETENTION_DESTINATION_INVALID`을 유지한다.
- 내부: `candidate.sqlite`, `snapshot.sqlite`. 우리가 방금 만든 디렉터리이므로 **남의 파일이 그 자리에
  있을 수 없다**. snapshot 정리가 남의 파일을 지우는 문제와 sidecar를 이름으로 지우는 문제가 사라진다.
- 해제: 디렉터리 하나를 지운다. `.releasing` 이동 단계가 없어지므로 그 크래시 고아도 사라진다.
- 운영 기록: `candidate_path`는 디렉터리 안의 파일 경로를 그대로 쓰고, 소유 증거(device·inode·birth
  time)는 지금 규칙을 유지한다.

### 운영 행 이전 크래시까지 덮으려면

디렉터리를 **고정된 부모** 아래 둔다: `<db와 같은 디렉터리>/retention-operations/<uuid>/`. 복구는 그
부모를 열거해 **행이 없는 디렉터리**를 발견할 수 있다. 발견 시 지우지 않고 보고한다(지금의
`retained_unproven`과 같은 태도). 이때 `freshPath` 인자는 사라지고 호출자는 부모만 정한다.

## 3. 바꿀 것 — (b) 교체 배타성

`wal_checkpoint` 이후의 마지막 확인부터 `renameSync`까지 다른 writer가 커밋하지 못해야 한다. SQLite
연결 하나로는 불가능하다(연결을 닫아야 rename할 수 있고, 닫으면 잠금이 풀린다). 선택지:

1. **swap lease 파일**: 모든 writer가 `AuthorityDb` 생성 시 공유 lease를 확인하도록 한다. 가장
   확실하지만 authority 연결 경로 전체를 건드린다.
2. **runtime 경유 강제**: 독립 `new AuthorityDb(path)` 사용을 금지하고 `AuthorityDatabaseRuntime`을
   유일한 진입점으로 만든다. 이미 quiesce가 있으므로 계약상 가장 자연스럽지만, 현재 코드베이스에는
   runtime을 거치지 않는 연결이 여러 곳 있다.
3. 현상 유지 + 명시: 남은 창을 문서화하고 운영 절차(단일 writer 보장)로 덮는다.

1과 2는 제품 전체 계약 변경이므로 소유자 결정이 필요하다. 이 노트는 선택을 하지 않는다.

## 4. 건드릴 파일과 회귀

| 파일 | 이유 |
|---|---|
| `src/local-observation-retention.ts` | 확보·해제·경로 파생 |
| `src/local-observation-retention-artifacts.ts` | `releaseProvenArtifact` 제거 또는 디렉터리 해제로 대체 |
| `src/local-observation-retention-recovery.ts` | 디렉터리 해제, 부모 열거, 행 없는 디렉터리 보고 |
| `src/local-observation-retention-swap.ts` | 디렉터리 안에서 rename, 성공 후 디렉터리 정리 |
| `src/local-observation-retention-service.ts` | 경로 대신 부모를 넘김 |
| `tests/fixtures/local-retention-crash-child.mjs` | 인자 의미 변경 |
| `tests/integration/local-observation-retention-destination.test.ts` | 목적지 계약이 디렉터리로 바뀜 (3 케이스 재작성) |
| `tests/integration/local-observation-retention-recovery.test.ts` | 후보 경로 참조 (8 케이스) |
| `tests/integration/local-observation-retention-schedule.test.ts` | 경로 인자 |
| `tests/integration/local-observation-retention.test.ts` | “원본 경로로 적용 거절” 케이스의 의미 재정의 |

## 5. 완료 판정

- 2차 리뷰의 네 재현(`residual-retention.mjs`의 `candidateFinalWindow`·`sourceFinalWindow`,
  `recovery-leaks.mjs`의 두 시나리오)이 모두 뒤집힐 것.
- 전체 verify 통과, 배포 migration 바이트 불변.
- **3차 독립 리뷰**를 같은 방식으로 받아 새 결함이 없을 것. 1·2차가 각각 9건을 냈고 그중 5건이 수정이
  만든 것이었으므로, 이 단위도 리뷰 없이 완료로 보지 않는다.
