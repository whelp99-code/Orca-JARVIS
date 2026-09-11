# 완료 작업 진행 원장 — 2026-09-11

`docs/claude-completion-instructions-2026-09-11.md`의 M0–M6을 수행하는 단일 재개 기준 문서다. 세션이 끊기면 이 원장을 먼저 읽고 이어간다. 기존 진행 문서(`docs/opus-fix-final-reply-2026-09-11.md` 등)는 덮어쓰지 않는다.

상태 값: `TODO`, `IN_PROGRESS`, `VERIFIED`, `EXTERNAL_BLOCKED`. 테스트 미작성·내부 결함·검증 실패·패키지 미생성은 외부 차단이 아니다.

## M0 기준 (실측)

| 항목 | 값 |
|---|---|
| worktree | `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui` |
| branch | `codex/routing-approval-ui` |
| M0 시점 HEAD | `082d689786970bc307a718d0cddf6f4fb2c9bf2e` (tree `61210bffd30ad0d6b428ae6e73456ac70464538d`) |
| tracking branch | `not_configured` (ahead/behind 측정 불가) |
| M0 시점 tracked 변경 | M 4 (`src/local-observation-retention-candidate.ts`, `src/local-observation-retention-selection.ts`, `src/local-observation-retention.ts`, `tests/integration/local-observation-retention-consistency.test.ts`), D 0 |
| M0 시점 untracked | `.omo/evidence/ulw/`, `.omo/ulw-loop/`, `node_modules` (도구 상태·공유 의존성, 커밋 대상 아님) |
| toolchain | Node `v24.19.0`, npm `12.0.2` |
| scratch | `/home/jm/.cache` (vda2, 664G 여유). private QA root `/home/jm/.cache/jarvis-m1-exact-20260911` |
| 자체 verify 실행 | 없음 (이 checkout 기준). 다른 프로젝트(mail-intelligence 등)의 장기 실행은 이 입력과 무관 |
| migration 해시 벡터 | 95개 파일, `migration-hash-vector.json`, 벡터 digest `94d414c32c648cc6…` |

직전 전체 gate의 범위(지시서 §2.1)는 제품 `61d6de1`이며, 그 이후 제품 코드가 바뀌었으므로 그 결과를 현재 트리에 소급하지 않는다.

## 단위 원장

| 단위 ID | 상태 | 근거 SHA | 파일·계약 | 인수 항목 | 실행 결과와 receipt | 다음 동작 | 외부 의존성 |
|---|---|---|---|---|---|---|---|
| M0-baseline | VERIFIED | `082d689` | 위 표, `migration-hash-vector.json` | 트리·도구·scratch·실행 중 gate 확인 | 이 문서의 M0 표 | M1 진행 | 없음 |
| M1-P1A-audit | IN_PROGRESS | 작업 트리 | `local-observation-retention*.ts` | 차단 context를 인용한 감사 행 보존 | 리뷰 재현 재실행: 후보 감사 행 3 (이전 2) — `jarvis-m1-exact-20260911/audit-and-values-result.json` | 정식 회귀로 고정 | 없음 |
| M1-P1B-values | IN_PROGRESS | 작업 트리 | 같은 모듈 | 값·열 경계 구분 | 리뷰 재현 재실행: 후보 값이 원본과 동일 (이전 변조본 통과) | 타입·길이 인코딩 회귀 고정 | 없음 |
| M1-shared-plan | IN_PROGRESS | 작업 트리 | `memory-authority-fresh-builder.ts`(copyExpression/copyFilter/tableColumns export), `memory-compaction-sanitize.ts`(suppressedRowMutations export), `local-observation-retention-candidate.ts` | 복사기·정제기 규칙을 검증기가 그대로 사용, 양방향 비교 | 실행 중 | typecheck·consistency 결과 확인 | 없음 |
| M2-recovery | TODO | — | 급사 복구·교체·일정화 | 격리 child process 인수 | — | M1 종료 후 | 없음 |
| M3-producer | TODO | — | assembler→추천→brief | fixture 수동 삽입 없는 제품 경로 | — | M2 종료 후 | 없음 |
| M4-second-brain | TODO | — | refresh receipt·출처/삭제 | 최신 계약 실연동 또는 §8.4 산출물 | — | 조사 착수 | provider 계약/권한 |
| M5-work | TODO | — | 실행자 준비·입력·성과 | 실행 증거 또는 준비된 적용안 | — | 설정 재확인 | 실행자 인증·외부 입력 권한 |
| M6-integration | TODO | — | 통합 리뷰·gate·패키지·제출물 | §11 종료 조건 | — | M1–M5 후 | 독립 리뷰 도구 가용성 |

## 증거 경로

- private QA root: `/home/jm/.cache/jarvis-m1-exact-20260911`
- 리뷰 원본 증거(변경 금지): `/home/jm/.cache/jarvis-r2-exact-review-20260911`, `/home/jm/.cache/jarvis-r2-copy-review-20260911`, `/home/jm/.cache/jarvis-final-review-20260911`, `/home/jm/.cache/jarvis-opus-review-20260910`
- 과거 gate 로그·receipt: `/home/jm/.cache/jarvis-lineage-qa`

## 운영 경계

push·merge·deploy·서비스 재시작·운영 DB/설정 변경·`current` 전환·타 작업 산출물 삭제는 하지 않는다. 이 원장은 개발 범위의 진행만 기록한다.
