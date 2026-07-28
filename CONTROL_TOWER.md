# JARVIS 관제탑 — 채널 레지스트리

이 리포지터리는 코드를 담지 않는다. JARVIS Master(사람 ↔ 프로젝트별 메인 에이전트)의 **소통 창구**다.
운영 규율은 [ORCA_MASTER_CHARTER.md](ORCA_MASTER_CHARTER.md)를 따른다.

- 관제탑 터미널(coordinator handle): `term_771c9810-de0c-4323-a90d-de30f6cef334` (`/Users/jmpark/Orca-JARVIS`)
- 모든 워커는 `worker_done` / `escalation` / `ask` 를 위 handle 로 보낸다.
- 개설: 2026-07-28

## 세션 재개 (새 세션은 이 절만 읽으면 된다)

컨텍스트 비용 때문에 관제탑 세션은 자주 비운다. 새 세션은 아래 프롬프트로 시작한다.

```
ORCA_MASTER_CHARTER.md 와 CONTROL_TOWER.md 를 읽고 JARVIS Master 로 이어받아라.
추측으로 상태를 만들지 말고 실제 Orca 상태를 읽어라. 미해결 항목부터 보고해.
```

**현재 미해결 (2026-07-28 22:40 기준)**

- 회수 대기 중인 dispatch 없음. 모든 채널 종결·검증 완료
- `term_d4bb2736` (sangfor-os-w0-w6) 자율 진행 중 — 운영 전환 차단 결함 조사, 결론 보고 대기
- `term_48b73d39` (wiki-spike GJC) 오너 사후 승인 후 구현 재개 — 감시 불필요
- 디스크 Data 볼륨 98% (여유 22Gi). 회수 가능한 캐시는 이미 정리함. 추가 정리는 `~/Library` 계열이라 오너 판단 필요
- `Playground/sangfor-os` 미처리 428건 — `.agents/results/2026-07-28-worktree-preservation-audit.md` 에 목록화만 됨
- Orca 워크트리 23개가 전부 `in-progress` 상태로 방치 — 카드 상태 정리 안 됨

## 구조 원칙

프로젝트별 메인 에이전트는 **해당 프로젝트의 기존 체크아웃 안에서** 돈다. 새 워크트리를 만들지 않는다 —
현재 모든 프로젝트의 핵심 작업이 미커밋 상태로 기존 체크아웃에 있어서, 새 체크아웃에는 그 작업이 딸려오지 않는다.
한 체크아웃에 워커가 둘 이상일 때는 파일 범위를 서로 겹치지 않게 금지 조항으로 분리한다.

## 채널 맵 (2026-07-28)

| 채널 | 프로젝트 / 체크아웃 | 메인 에이전트 | task / dispatch | 담당 |
|---|---|---|---|---|
| P1 | sangfor-engineer-mcp<br>`Playground/whelp99-code-sangfor-engineer-mcp` | `term_92dea65a` (grok) | `task_4a7fd29b5001` / `ctx_63c3af94cb6c` | **완료** — 아래 참조 |
| P2 | sangfor-os-w0-w6<br>`Playground/sangfor-os-w0-w6` | `term_d4bb2736` (자율 진행) | dispatch 없음 (status 통보만) | 운영 전환 차단 결함 조사 계속 |
| P3 | u076-hardening<br>`orca/workspaces/sangfor-os/u076-hardening` | `term_ec10446c` (codex) | `task_b48b89c0282a` / `ctx_d7b5757d017e` | **완료** — 아래 참조 |
| P4 | wiki-spike<br>`orca/Wiki-spike/wiki-spike` | `term_9847a992` (claude) | `task_ae43f74d373e` / `ctx_b4f5d1765d67` | **완료** — 아래 참조 |
| P4b | wiki-spike (후속 보존) | `term_9847a992` (claude) | `task_f72e2b3da55d` / `ctx_3ee836605c6e` | **완료** — `ce6e8b1`(red-team 58건 정합), `c084d79`(리포트 영속화 + `.DS_Store` ignore) |
| P5 | sangfor-os<br>`Playground/sangfor-os` | `term_3b560a10` (codex) | `task_d5f86012a7da` / `ctx_88e817e02870` | **완료** — 아래 참조 |

## 진행 중 — sangfor-engineer-mcp `resolveRepoData` 접두사 결함

`term_e539cb05` 가 실장비 ObserverSessionManager 캡처 실증(PID/page/URL/storage invariant PASS) 중 발견.
데이터 루트 해석 호출부 **4곳**이 `data/` 접두사를 빠뜨려 repo root 직하로 떨어진다.

| 파일 | 인자 |
|---|---|
| `scripts/strategy-cli.ts:89` | `resolveRepoData('learning-strategies')` |
| `packages/sangfor-learning-strategy/src/service.ts:133` | `resolveRepoData('learning-strategies')` |
| `apps/mcp-server/src/index.ts:870` | `resolveRepoData('captures')`, `resolveRepoData('capture-staging')` |

Master 독립 확인: `packages/shared/src/index.ts:70` 의 helper 는 env override 부재 시 `findRepoRoot()` 에
subdir 를 그대로 이어 붙인다. 다른 데이터 호출부는 예외 없이 `data/` 접두사 사용(`data/registry`,
`data/runs`, `data/runtime`, `data/wiki`, `data/specs`, `data/sizing`, `data/evidence`, `data/feedback`,
`data/evals`, `data/competency`). **결함은 호출부에 있고 helper 에 있지 않다.**

승인 조건: helper 시그니처·해석 규칙 불변(20곳 넘는 호출부가 현 계약에 의존) / 리터럴 확정은 계획 정본 인용 근거 필요 /
기존 env override 동작 보존 / 해석 경로를 pin 하는 회귀 테스트 추가 / 테스트 실행 증거 제출 / push·브랜치 변경 금지.

**완료 — 2026-07-28 22:40 (verified).** 커밋 `5257534 fix(learning): anchor observer data paths`, 4 files +45/−3.
`data/runtime/learning-strategies`(서비스+CLI), `data/captures`, `data/runtime/learning-captures` 로 정정.

- `packages/shared` 가 커밋에 없어 helper 무변경 확인 — 20곳 넘는 호출부 계약 보존
- CLI `--root` > `SANGFOR_LEARNING_STRATEGY_ROOT` > default 우선순위 유지
- 신규 `tests/learning-path-contracts.test.ts` 가 새 형태 존재와 옛 형태 부재를 **양방향으로 pin** (요구 이상)
- 격리 clone 검증: 659 passed + 2 skipped, lint/build, observer E2E(storage 0, mutation delta 0, PID/page invariant true), MCP 85-tool smoke 전부 exit 0. Grok staged diff review APPROVE (C/H/M 0)
- Master 독립 확인: branch 미변경, worktree clean, upstream tracking 없음 → push 흔적 없음

**실환경 검증 (테스트 그린 ≠ 실환경 그린).** 로그인된 전용 loopback CDP(127.0.0.1:9333)에서 실제 MCP
`getToolHandler` 경로로 `attach_observation_session` → `manage_learning_capture` start/stop 을 실행.
산출물이 수동 이동 없이 `data/captures/` 에 직접 생성됨(`storageRootCorrect=true`), SHA-256 = bundleDigest 일치,
Keychain 키로 decrypt round-trip 성공(networkCount 8, storageMutationCount 0, elementCount 2552).
Master 확인: `.enc` 번들 4개 전부 mode 0600 + git-ignored, 마지막 mtime 22:33 이 커밋 이후라 수정 코드가 직접 쓴 것,
옛 경로 `captures/`·`learning-strategies/` 소멸. 번들 내용은 열지 않고 권한·위치·무시 상태만 확인.

잔여물 1건(조치 불요): 리포 루트 `capture-staging/` 빈 디렉터리. 파일 0개·0B 이고 git 이 빈 디렉터리를
추적하지 않아 porcelain 에도 안 잡힌다. 옛 코드가 만든 잔해일 뿐 위험 없음.

## 해소됨 — 오너 사후 승인 (2026-07-28)

오너가 "GJC는 그냥 작업하게 두어라, 내가 승인한 내용이다"로 직접 확인했다.
`5203a63` 의 `src/` + `tests/` 는 사후 승인으로 유효하며 되돌리지 않는다. HOLD 는 해제됐고
planning-only 제약은 이 건에 한해 철회, GJC 는 구현 포함 원래대로 진행한다.

**교훈:** Master 가 게이트를 승인할 때 붙인 planning-only 조건이 오너의 실제 의도보다 좁았다.
계획 문서의 자기 선언(`authorizes no code`)을 오너 의도와 동일시한 것이 원인이다.
다음부터 계획 문서의 범위 선언과 오너 위임 범위가 어긋날 수 있는 건은 조건을 붙이기 전에 오너에게 확인한다.

### 경위 기록 — wiki-spike `5203a63` `gate_e1684a7f088b` 를 "APPROVE Option A — planning only" 로 승인해
`term_48b73d39` 에 전달했으나, GJC 세션이 곧바로 `5203a63 define second-brain Stage 0 contracts` 로
프로덕션 소스 **462행**을 커밋했다: `second_brain_contracts.py` +228, `workspace_format.py` +183/−10,
`second_brain_ports.py` +43, `cli.py` +6/−1, `workspace.py` +2/−1.
승인문은 코드 작성을 명시적으로 제외했으므로 범위 위반이다.

전체 집계 — `5203a63` 은 19 파일 **+1111 / −12**:

| 범위 | 파일 | 증감 | 승인 범위 |
|---|---|---|---|
| `docs/` (ADR-0028, DB-01~08 결정 레코드) | 9 | +374 | **내** |
| `schemas/second-brain/` | 2 | +54 | **내** |
| `src/wiki_spike/` | 5 | +462 / −12 | **밖** |
| `tests/second_brain/`, `test_cli.py`, `test_workspace_format.py` | 3 | +221 | **밖** |

- Master 가 `src/` 정지 HOLD 를 걸었고 GJC 는 `Collecting terminal HOLD verdict` 로 정지, 그 사이 새 커밋 없음
- P4b 워커(`term_9847a992`)가 같은 관측을 독립적으로 제보해 교차 확인됨
- 오너 사후 승인으로 HOLD 해제, 작업 재개

부수 채널: `term_e539cb05` — 자율 진행. 실장비 캡처 실증 중 tracked 코드 결함을 발견해 수정 권한을 요청,
2026-07-28 조건부 승인. 상세는 아래 참조.

### 좌표 함정 — 터미널의 Orca 워크트리 ≠ 실제 작업 트리

`term_e539cb05` 의 Orca 기록 경로는 `Playground/whelp99-code-sangfor-engineer-mcp` 이지만,
실제 작업 트리는 형제 워크트리 `/Users/jmpark/.codex/worktrees/pr001-plan-completion-sangfor-engineer-mcp`
(branch `integration/pr001-security-followups`)다. Master 가 Orca 기록 경로에서 인용된 파일을 찾지 못해
한때 보고를 의심했으나, 전역 검색으로 형제 워크트리에서 전부 확인됐다.
**워커 보고를 검증할 때는 Orca 의 worktreePath 를 신뢰하지 말고 절대 경로·브랜치를 확인한다.**

## 공통 금지 사항

모든 워커에게 동일하게 걸어 둔 제약:

- `git push`, PR 생성, 브랜치 변경/삭제 금지
- `git checkout` / `restore` / `clean` / `reset --hard` 등 변경 폐기 계열 명령 금지
- 증거 없는 완료 주장 무효 — 실행한 명령과 그 출력을 `worker_done` 본문에 포함

## 완료 기록

### P1 / sangfor-engineer-mcp — 2026-07-28 22:05 (verified)

- `/tmp` 에 있던 검증 리포트를 `docs/superpowers/results/final-verification-a83bd7c.md` (5550 bytes)로 영속화
- 계획·진행 문서의 최종 tip 표기를 `87c91d0` → `a83bd7c` 로 정정. `docs/` 하위 `87c91d0` grep **0건**
- 커밋: `7e15649` (docs/fable-doctrine-agents), `8a1f6e2` (형제 워크트리 `.codex/worktrees/pr001-plan-completion` 의 integration/pr001-security-followups, 문서 3개만)
- 미커밋 잔여 3건은 문서 산출물이 아니라 동시 작업/테스트 잔여물(PPTX mtime, `outputs/live_*`, 미추적 `packages/sangfor-learning-strategy`)로 남겨 둠
- Master 독립 확인: 브랜치 미변경, tip `7e15649`, porcelain 잔여물이 보고와 정확히 일치, upstream tracking 없음 → push 흔적 없음

### P4 / wiki-spike — 2026-07-28 22:12 (verified) — **Master 오진 정정**

브리핑에서 `term_48b73d39` 를 교착으로 분류한 것은 오진이었다. 그 터미널은 `gjc ralplan` stage 3 를
**스스로 생성 중**이었고 45초 사이 출력이 986행 늘어난 생존 상태였다(cursor 22437→23423).
기다리던 `stage-03-final.md` 는 다른 워커의 결과가 아니라 자기 산출물이며 이미 기록·해시 인덱싱까지 끝나 있었다.

- Master 독립 확인: `stage-03-final.md` 36538 bytes (mtime 22:01), `pending-approval.md` = `BLOCKED FOR CONSENSUS`
- 실제 게이트는 사람 승인 하나 → `gate_e1684a7f088b` 로 등록
- 미커밋 11건 중 유실 위험은 `red-team-report.json` 1건뿐. 커밋본이 `adversarial_case_count=58` 을 선언하면서
  `cases` 는 7개만 담은 실제 불일치였고 워킹트리가 58개로 채워 놓은 상태임을 Master가 직접 확인
- 워커는 활성 GJC 세션 디렉터리에 아무 파일도 만들지 않았다 (올바른 판단)

### P5 / sangfor-os — 2026-07-28 22:10 (verified)

- porcelain 86 항목은 실제 **689 파일**이었다. 분류: 의도된 문서 3 / 테스트·QA 증거 352 / 생성·운영 산출물 259 / 잔여 디버그 74 / 정체불명 1
- 커밋 `1e262f7b` (로컬 생성물 ignore), `666d7081` (7월 운영 계획 보존), `5b4c1632` (감사 리포트)
- `pnpm test` exit 0, 1,010 passed / 70 skipped
- 미처리 428건은 임의 커밋하지 않고 `.agents/results/2026-07-28-worktree-preservation-audit.md` 에 목록화
- Master 독립 확인: 브랜치 미변경, 3개 커밋이 `d3ebfd8e` 위에 순서대로 존재, porcelain 86→31, staged 0

### P3 / u076-hardening — 2026-07-28 22:01 (verified)

디스패치 시점에 전제가 이미 바뀌어 있었다. 워커가 발견한 사실: 미커밋 8건이 아니라 0건이었고,
`ef0e6010` 의 직계 후속 커밋 `7a239d14 fix(qa): harden U076 real-use isolation` (2026-07-28 21:56:59 KST)이
U076 하드닝 9개 경로를 이미 보존하고 있었다. 워커는 중복 커밋을 만들지 않고 검증만 수행했다.

- 재실행 명령: `bash scripts/run-workspace-runtime.sh root -- node --test scripts/qa/run-real-use-100.test.mjs scripts/qa/seed-real-use-mail.test.mjs`
- 결과: exit 0, tests 17 / pass 17 / fail 0 (기존 16-green 주장을 상회)
- Master 독립 확인: HEAD `7a239d14`, parent `ef0e6010`, `git status --porcelain` 빈 출력, 9 files / +899 −170

## Master 직접 처리 이력

- 2026-07-28 — 고아 터미널 8개 정리(스크롤백 전부 비어 있음을 확인 후 close, 7건 성공 / 1건은 이미 탭 소멸)
- 2026-07-28 — `task_0a6b263891e4` (R14 AI review honesty QA, 2026-07-13 생성) `failed` 종결.
  사유: Antigravity 쿼터로 미실행, `retryAfter` 15일 경과, 대상 리포가 그 사이 다른 브랜치로 이동해 픽스처 전제가 무효
- 2026-07-28 — `JARVIS Morning Brief` 자동화 재활성화. RRULE 재적용으로 `nextRunAt` 을 과거(07-27 09:00)에서 **2026-07-29 09:00 KST** 로 정정
