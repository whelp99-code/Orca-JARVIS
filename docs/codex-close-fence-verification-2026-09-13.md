# JARVIS close 경계 결함 수정·검증 — 2026-09-13

현재 제품/검증/패키지 기준은 이 문서와 연결된 receipt다. 2026-09-12의 “A/B 모두 닫힘” 문구와 gate45는 이후 재현된 close 경계 결함의 완료 증거가 아니다.

## 판정과 범위

**이번 close-fence 수정 범위: VERIFIED. 전체 M0–M6: IN_PROGRESS.** 전체 verify와 독립 리뷰는 아래 범위의 완료 근거이며, 마지막 절의 내부 잔여 A–C는 후속 구현 지시서로 이어진다.

수정은 SQLite 연결의 잠금을 해제한 뒤 그 안에서 커밋된 행이 새로운 물리 비교 기준에 섞여 소실되던 결함을 다룬다. 일반 memory compaction, cancellation purge, local retention 교체에 공통 내용 fence를 적용했다. 검증 뒤 늦게 쓰인 내용은 원본/퇴거본에 보존하며, 이를 모든 프로세스의 쓰기를 배제했다는 뜻으로 쓰지 않는다.

- checkout: `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`
- branch: `codex/routing-approval-ui`; upstream 미설정(ahead/behind 측정 불가).
- 시작 HEAD: `3bff3efe9d95012f82150b123536b4687049c345`.
- 전체 gate 입력: 위 HEAD에 단계화한 tree `222cfb394e897ae4db25f322a32789c6e9cb4046`. 단순 HEAD만으로 이 입력을 식별하면 안 된다.
- 제품 커밋: `18b73ede9a369ae8cb34bb44885bf6cbef9f2687` (close fence), `4aa814769c2553d753037de46a510decb5d81c40` (테스트 helper). 위 gate tree와의 동일성은 receipt로 확인했다.
- private QA: `/home/jm/.cache/jarvis-direct-close-fix-20260913-34ppij_t` (아래 `<QA>`).

## 중단 원인과 감시 복구

마지막 실제 OmO 작업은 2026-09-12 22:37 KST였다. close 경계 실패 회귀는 정식 테스트에서 빠진 채 QA 파일로 보존됐고, 별도 guard connection 접근은 12/16 실패 뒤 되돌려졌다. 감시는 두 번 재지시 뒤 `action_required`로 자동 전송을 멈췄다. 외부 승인이나 인증이 필요한 문제가 아니었지만 새 기술적 해결을 이어가지 못했다.

2026-09-13에는 Codex가 단독 구현자로 인수하고 기존 OmO를 읽기 전용 독립 리뷰어로 지정했다. 코드와 실패 회귀를 직접 수정·실행했다. 감시 v4는 같은 문구의 반복을 금지하되, 기술적 실패를 두 번의 재지시만으로 방치하지 않고 실패 원인·새 가설·다음 최소 작업으로 이어가도록 수정했다. 단일 구현자와 살아 있는 검증을 보호한다.

자동화 `39462d62-b3e2-4403-b88c-8952dbbd5b85`, Asia/Seoul `*/30 * * * *`. v4 적용 후 수동 run84의 실제 점검 receipt는 `~/.cache/jarvis-codex-claim-review-20260911-4ztfcjp6/monitor-check-20260913T032437664204Z.json`이다. dispatch의 completed와 점검 완료를 구분했다. 부모 실행 중 OmO에게 구현 지시를 보내지 않은 것도 receipt에 기록돼 있다.

## 재현 → 수정

| 사례 | 수정 전 실측 | 수정 후 인수 |
|---|---|---|
| memory source native close 직후 INSERT | 커밋 성공·swap 성공·행 소실 | 교체 전 `MEMORY_SOURCE_CHANGED_DURING_CLOSE`, 원본 inode/행 유지 |
| 같은 행 수 UPDATE(attempts) | 커밋 성공·swap 성공·값 소실 | 위와 동일, 수정된 값 유지 |
| 비교용 probe native close 뒤 INSERT/UPDATE | 새 경계 회귀 | `MEMORY_PURGE_LATE_COMMIT_UNRESOLVED`, 커밋한 내용이 원본 또는 퇴거본에서 읽힘 |
| retention source close #1 | 커밋 성공·swap 성공·행 소실 | 공통 내용 fence로 원본 보존 |
| retention 첫 잠금 probe close #2 | 커밋 성공·swap 성공·행 소실 | 물리 기준을 이전에 고정해 퇴거본 보존 |
| retention 새 probe를 포함한 close #1–4 | 각 위치에 실제 SQLite 쓰기 주입 | 성공 커밋 내용 보존; 오류 코드만 보고 통과시키지 않음 |
| writer 없는 정상 retention | 대조군 | inode 교체 성공, 불필요한 퇴거본 없음 |
| 같은 DB 크기·동일 mtime로 복원한 UPDATE | 메타데이터만으로는 미변별 | 실제 바이트 SHA256으로 변경 탐지 |
| 읽기 실패/스캔 중 hardlink | 고정 회귀 | 거절·barrier 해제·연결 재개; 안정된 링크는 정상 해시 |

모두 격리 DB다. `withProvableExclusion`을 쓰는 fixture는 publication 허용 조건을 명시한 것이며 실제 호스트 전체의 OS 배타성 증거가 아니다. native close 후킹은 실 SQLite 커밋을 결정적으로 주입한다.

## 구현

1. `authority-database-content.ts`: schema와 전체 행의 SQL 값·타입·rowid를 읽는다. INTEGER는 bigint로 읽어 REAL/NULL/BLOB과 구분한다. 행 해시를 정렬하고 중복 수를 보존한다. WITHOUT ROWID는 실제 열 값으로 비교한다. V8 직렬화는 동일 프로세스 안의 일시 비교용이며 영구 저장 포맷이 아니다. 현재 migrations에 virtual table은 없고, 등장하면 명시 거절한다.
2. `authority-database-close-fence.ts`: 기존 EXCLUSIVE 안에서 source 내용을 고정한다. readonly probe를 미리 초기화하되 읽기 transaction은 유지하지 않는다. source를 닫고 물리 기준을 먼저 잡은 다음 probe의 새 snapshot을 읽어 비교한다. 닫는 동안 바뀌었거나 읽기 실패면 publish 전 거절·복구한다. 라이브 writable AuthorityDb는 기존 configure에서 WAL을 설정한다.
3. 두 swap은 동일 helper를 사용한다. retention은 이후 잠금 probe가 끝난 뒤 기준을 다시 만들지 않는다.
4. `authority-file-content.ts`와 retirement evidence: main DB·비어있지 않은 WAL·rollback journal의 실제 내용을 64KiB 버퍼로 해시한다. 스캔 전후 fd의 device/inode/size/mtime/ctime를 확인한다. SHM은 재생성 가능한 cache, 0바이트 WAL은 frame 부재로 처리한다. 읽기 불명은 unchanged가 될 수 없다.

전체 논리 스캔은 행 수에 비례하는 비용과 행 해시 배열을 사용한다. 물리 스캔의 버퍼 상한만 64KiB이며 전체 실행의 메모리 상한이라는 뜻은 아니다. 격리된 최신 패키지에서 각 1회 측정: 1,000행 15.77ms, 10,000행 158.69ms, 50,000행(12,840,960B) 829.51ms; 모두 행 수 보존. 같은 프로세스에서 순서대로 측정한 종료 후 RSS는 각각 89,972,736 / 143,081,472 / 343,392,256B다. peak/RSS 상한 또는 동시 처리 성능으로 해석하지 않는다. `packaged-fence-measure.log`에 원시 수치와 패키지 내부 dependency 해상 경로를 남겼다.

## 검증 증거

| 실행 | 실제 입력/결과 | receipt |
|---|---|---|
| memory 수정 전 | 2개 유실 반례 실패, RC1 | `baseline-corrected-receipt.json` |
| retention 수정 전 | close #1/#2 실패, #3 보존; RC1 | `retention-baseline-corrected-receipt.json` |
| 최종 관련 회귀 | 11파일 85테스트, RC0, 209.16초 | `stable-regression-receipt.json` |
| native 파일 스캔 경합 | 1파일 1테스트, RC0 | `file-content-corrected-receipt.json` |
| 전체 verify | RC0; 604파일 / 4,176테스트; 2026-09-13 03:42:38.469577Z → 04:10:01.268629Z; 입력 불변 | `verify2-input.json`, `verify2-receipt.json` |
| 독립 리뷰 | 기존 OmO 실제 diff 읽기, 이 범위 P1=0/P2=0. 리뷰어는 테스트를 실행하지 않음 | `review-final-screen.json`, `review-delivery-*.json` |
| migrations | 시작 HEAD 대비 기존 103파일 변경 0, 신규 0 | `migration-check.json` |
| 최신 패키지 | `<QA>/packages/jarvis-runtime-L3H9Xx`, 1,556 payload 파일·6,668 dependency entries; build/verifier/HTTP/packaged fence 실측 모두 RC0. HTTP 6개 응답 200, 정상 종료 RC0. `deployment_ready=false` | `runtime-package-pin.json`, `package-build-receipt.json`, `package-verify-receipt.json`, `package-http-receipt.json`, `packaged-fence-measure-receipt.json` |

실패는 보존하고 합격 근거에서 제외했다: 첫 UPDATE가 immutable 열을 바꿔 거절된 구성 오류(`baseline.log`), migration 이전 runtime 생성 오류(`retention-baseline.log`), 첫 readonly probe가 빈 WAL/SHM을 생성해 정상 cancellation 6건을 거절한 중간 제품(`expanded.log`), ESM namespace를 spy할 수 없었던 구성 오류(`file-content.log`). 모두 후속 유효 실행과 구분했다. 첫 전체 verify는 기존 테스트 helper가 소멸한 PID의 ESRCH를 처리하지 못해 1건 실패했다. 실패 입력을 중단해 RC130으로 보존했고(verify-receipt.json/verify-stop-receipt.json), ENOENT/ESRCH만 프로세스 소멸로 분류하도록 보완했다. 해당 8테스트가 RC0으로 통과한 뒤 새 tree에서 verify2를 수행했다. 생산 cleanup 코드나 생존 확인 assertion을 약화하지 않았다. 과거 gate45 및 오늘의 부분 회귀를 새 전체 gate 결과로 소급하지 않았다.

패키지 receipt 독립 pin: `e6d060d35695003feaf9ea17ccecd4080d8aa9f5ee406c8096f26cf9b56016ce`. package source HEAD는 제품 `18b73ed…`와 일치한다. `source_dirty=true`는 미추적 도구/공유 의존성 3건이 있는 상태이며, 제품 커밋 직후 tracked 변경은 0이었다. 검증/패키지/문서 사이 source 변경 여부는 commit receipt와 git diff로 대조한다.

## 최종 잔여와 다음 동작

| 내부 잔여 | 확인 근거 / 다음 동작 |
|---|---|
| A: 실제 assembler → 추천 생산 연결 | citation 분류 함수의 생산 코드 호출자 0, 저장 evidence_kind의 직접 비교, 수동 kind를 구성하는 기존 fixture를 직접 확인했다. 출처를 증명하는 제품 adapter와 생산→발행 인수를 구현한다 |
| B: 저장된 task 파생 기억의 현재 재사용 차단 | 기존 후보 쓰기 차단·withdrawal 목록을 현재 context/조회 소비에 연결했는지 확인하고, 빠진 연결·재시작/IO 경합/복원 인수를 완료한다. 원격 삭제를 합성하지 않는다 |
| C: 최종 패키지의 provider/process 인수 | 이번 패키지/HTTP/close fence 실측과 전체 제품의 M2/M3/provider 프로세스 인수를 구분한다. A/B 이후 최종 입력으로 필요한 프로세스 시험과 manifest를 마감한다 |

실행 지시서는 [omo-next-units-2026-09-13.md](omo-next-units-2026-09-13.md)다. 기존 OmO가 문서의 사실·누락·실행 가능성을 읽기 검토했고, 외부 계약 없이 가능한 내부 작업임을 확인했다. 구현권을 반환하는 별도 전달 뒤 기존 OmO 단독 실행과 30분 감시를 이어간다. 최종 상태는 내부 잔여를 닫은 뒤 다시 판정한다.

실제 외부 입력은 provider refresh/철회 계약, 운영 executor 자격 증명, 운영 적용·프로젝트 범위 결정 등이다. 기존 준비물을 유지하고 필요 입력·재개 조건을 최종 원장에 분리한다. 설치된 Second Brain release 경로는 2026-09-13 readlink 기준 `41f0751aca8906d612961e704bc60dd0855fdabd`; 이 확인에서는 설정 본문을 읽거나 provider를 호출하지 않았다.

`push`, `merge`, `deploy`, 서비스 재시작, 운영 DB/config/current 변경은 수행하지 않았다. `/tmp`와 다른 작업의 산출물도 삭제하지 않았다. 검증과 패키지는 private QA 경로에서 수행했다. 운영 서명·활성화 및 실제 provider/executor 인증의 부재를 fixture나 로컬 해시로 대신 증명하지 않는다.

## 최소 재검증

1. 위 checkout/branch, 제품 commit tree와 `verify2-receipt.json`의 index tree 및 input 불변 여부를 대조한다.
2. 정식 `memory-authority-close-boundary`, `local-retention-close-boundary`, `authority-database-close-fence`, `retirement-evidence`, `authority-file-content` 회귀를 필요 범위에서 실행한다. 실행은 `node scripts/run-tests.mjs backend --no-file-parallelism <tests/...>`이며 runner의 private TMPDIR 정책을 사용한다.
3. 최신 package receipt의 독립 pin으로 `scripts/verify-runtime-package.mjs`를 실행하고 HTTP receipt와 manifest hash를 대조한다.
4. 완료 판정은 이 수정 범위와 전체 M0–M6 잔여를 구분한다. 새로운 변경/실패 근거 없이 같은 전체 gate를 반복하지 않는다.
