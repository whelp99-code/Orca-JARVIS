# 61d6de1 재검토 — 삭제 허용 정책과 값 인코딩

## 판정과 검증 기준점

**이전의 작업 1건 누락 재현은 수정됐지만, R2에는 아래 두 P1 반례가 남아 있다.** 전체 verify 통과를 인정하면서 제품 인수는 보류한다.

- 제품 기준 SHA: `61d6de166344f62d2cd5003b6e1b1038ed37bd4b`.
- 리뷰 중 확인한 후속 HEAD: `2f159e0af71d4dbd2545289b89166a0bf4c9d5ea`, 문서만 변경.
- worktree: `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`.
- `verify-receipts.json`에서 mon_9YAYMPKRP0GXFC8A의 exit 0, 종료 2026-09-11 09:33:12 KST를 확인했다. 원본 monitor 회수 주체는 Opus다.
- 로그 실측: backend 275파일/1,886 + 275파일/1,917, dashboard 38파일/263 = **588파일/4,066테스트**. architecture 658모듈/2,444간선/순환 0. acceptance gjc_dispatched=false.
- 현재 소스 input 및 dist artifact를 다시 해시해 해당 build metadata와 일치함을 확인했다. input=`sha256:329bb698943fe67a3aee9b3059d1c6dd64df880971da621bd70510ce10463fbc`, artifact=`sha256:d4d49f773735fce65c2d791489e5409c1b57edb3f1694a738e4470b4e3149571`.
- 제품 소스·테스트·migration을 수정하지 않았고 전체 verify를 새로 실행하거나 중단하지 않았다.

기존 ABA 재현의 직접 재실행: 정상 대조군은 후보 작업 1건 보존, 교체 실험은 LOCAL_RETENTION_CANDIDATE_MISSING_ROW / candidate_exists=false, 원본 작업 1건 유지였다. 이 수정 효과는 확인됐다.

## P1-A — 차단 ID를 가진 감사 행도 보존해야 함

위치: `src/local-observation-retention-candidate.ts:113`.

현재 누락 허용 조건은 행의 **어느 열에서든** blocked ID와 같은 문자열을 찾는 것이다. 그러나 삭제 가능한 모든 행이 차단 ID를 갖는다는 성질은, 그 ID를 가진 모든 행을 삭제해도 된다는 뜻이 아니다.

구체적으로 `personal_context_audit_events.subject_id`는 차단될 context ID를 담을 수 있지만 이 감사 행은 보존 대상이다. 실제 복사기는 `src/memory-authority-fresh-builder.ts:197`에서 이 표를 context 삭제 필터에서 명시적으로 제외한다. 새 검증기는 이 예외를 잃었다.

실제 compiled apply 재현:
1. 기존 local observation→context→recommendation fixture를 원본에 생성한다.
2. 원본 backup으로 만든 대체 fixture에서 해당 context의 감사 행 1개만 제거한다. 대체 fixture의 immutable guard를 잠시 해제하고 원래 SQL로 복원했으며, 제품 migration이나 원본 guard는 변경하지 않았다.
3. 정상 대조군과 native ATTACH 전후 실제 rename을 넣은 ABA를 각각 실행한다. ABA는 DELETE 모드 대체 DB를 읽은 직후 원래 pathname을 복구한다.

| 결과 | 값 |
|---|---|
| 선정 | observation/context/recommendation 각 1개 |
| 원본 감사 행 | 3 |
| 정상 대조군 후보 감사 행 | 3 |
| ABA 후보 감사 행 | **2** |
| apply 오류 | null |
| 후보 재검증 | **통과** |

이 후보는 실제 복사 계약이 보존해야 할 감사 행을 잃었다. 임의 열의 ID 일치로 누락을 허용하는 검사를 테이블·열·projection kind별 정확한 삭제 정책으로 바꿔야 한다.

## P1-B — 서로 다른 행 값이 같은 해시 입력으로 합쳐짐

위치: `src/local-observation-retention-candidate.ts:21`, 특히 `.join(" ")`를 사용하는 `:27`.

각 문자열 앞에 `s:`를 붙이고 공백으로 합치면 문자열 안의 공백과 `s:`가 열 경계와 구별되지 않는다. 두 행은 SHA-256에 들어가기 전부터 같은 문자열이 된다.

`live_supervisor_reports`에 대해 실제 SQLite 제약을 만족하는 합성 원본/대체 fixture로 재현했다. 다른 열 값은 같으며, 아래 두 열만 다르다.

| 열 | 원본 / 정상 대조군 | ABA 후보 |
|---|---|---|
| report_id | `r s:/foo` | `r` |
| canonical_path | `/bar` | `/foo s:/bar` |

두 열의 직렬화 결과는 모두 `s:r s:/foo s:/bar`다. source와 candidate의 실제 값은 다르지만, blocked=[]인 apply가 오류 없이 성공하고 후보 재검증도 통과했다. 이 fixture는 실제 보고서 생성 API의 인수 검증이 아니라, 후보의 SQLite 행 값을 비교하는 방어의 반례다.

문자열 구분자를 바꾸는 것으로 끝내지 않는다. 타입과 길이 또는 구조화된 배열 경계를 명확히 보존하는 인코딩으로 비교해야 한다.

## 후속 작업 지시

1. 두 반례를 각각 실패 회귀로 추가한다. 기존 작업 누락·외래 행·동일 행 수·journal 조합·ATTACH ABA·destination 보호 회귀를 보존한다.
2. 복사기와 검증기가 **같은 명시적 테이블별 변환 계획**을 사용하도록 정리한다. 삭제 허용은 table + 지정 열 + projection kind/id에 결속한다. 임의 열 값 일치나 문서상의 성질만으로 허용하지 않는다.
3. 최소한 `personal_context_audit_events`는 차단 ID를 인용하더라도 보존해야 한다. 다른 audit/참조 표도 실제 copyFilter 계약과 대조한다. 새 반례 하나에만 예외를 추가하지 말고 모든 지원 표의 keep/remove/transform 규칙을 완결한다.
4. 행 값 비교는 경계가 모호하지 않은 typed tuple 인코딩 또는 동등한 정확한 비교를 사용한다. 공백·구분자·따옴표·빈 문자열·NULL·바이너리·숫자를 포함해 서로 다른 값 조합이 같은 비교 키가 되지 않는 회귀를 둔다.
5. 후보에 허용하지 않은 행이 생기지 않는지와, 남아야 하는 행이 사라지지 않는지를 양방향으로 검사한다. 생성/변환되는 표도 실제 허용 변화만 인정한다. migration 수나 active generation 숫자만으로 해당 표 전체의 내용 동일성이 증명됐다고 표현하지 않는다.
6. 수정 후 관련 retention/공유 builder 회귀를 통과시키고, 제품 변경이 통합된 시점에 전체 verify를 1회 수행한다. R2 전체 독립 재검토에는 새 두 반례, 이전 지적, 복사/검증 정책의 동일성을 포함한다.

운영 교체나 새로운 삭제 정책에 대한 사용자 결정을 기다려야 하는 사항이 아니다. 기존 감사 보존과 원본 값 일치 계약을 지키는 코드 수정이다. 급사 후 부분 파일 복구는 별도 미해결 항목으로 유지하며, 기존 목적지 보호를 약화하지 않는다.

## 증거

`/home/jm/.cache/jarvis-r2-exact-review-20260911`:
- `aba-omission.mjs`, `aba-omission-result.json`: 이전 작업 누락 재현의 차단 확인.
- `audit-and-values.mjs`, `audit-and-values-result.json`: 위 두 반례의 정상 대조군 + native ATTACH 전후 실제 rename 재현.
- `build-identity.json`: 리뷰 당시 소스·dist와 metadata 일치.

실행: `node /home/jm/.cache/jarvis-r2-exact-review-20260911/audit-and-values.mjs`.
테스트는 각 호출 전용 scratch DB만 사용하고, prepare wrapper를 finally에서 복구하며 fixture를 정리한다. 출력 스크립트의 exit 0을 제품의 수정 완료로 해석하지 않는다. 실제 운영 DB·원본 증거·타 작업 산출물은 변경하지 않았다.
