# JARVIS 관제탑 — 채널 레지스트리

이 리포지터리는 코드를 담지 않는다. JARVIS Master(사람 ↔ 프로젝트별 메인 에이전트)의 **소통 창구**다.
운영 규율은 [ORCA_MASTER_CHARTER.md](ORCA_MASTER_CHARTER.md)를 따른다.

- 관제탑 터미널(coordinator handle): `term_771c9810-de0c-4323-a90d-de30f6cef334` (`/Users/jmpark/Orca-JARVIS`)
- 모든 워커는 `worker_done` / `escalation` / `ask` 를 위 handle 로 보낸다.
- 개설: 2026-07-28

## 구조 원칙

프로젝트별 메인 에이전트는 **해당 프로젝트의 기존 체크아웃 안에서** 돈다. 새 워크트리를 만들지 않는다 —
현재 모든 프로젝트의 핵심 작업이 미커밋 상태로 기존 체크아웃에 있어서, 새 체크아웃에는 그 작업이 딸려오지 않는다.
한 체크아웃에 워커가 둘 이상일 때는 파일 범위를 서로 겹치지 않게 금지 조항으로 분리한다.

## 채널 맵 (2026-07-28)

| 채널 | 프로젝트 / 체크아웃 | 메인 에이전트 | task / dispatch | 담당 |
|---|---|---|---|---|
| P1 | sangfor-engineer-mcp<br>`Playground/whelp99-code-sangfor-engineer-mcp` | `term_92dea65a` (grok) | `task_4a7fd29b5001` / `ctx_63c3af94cb6c` | 문서 드리프트(87c91d0→a83bd7c) 정정, `/tmp` 검증 리포트 영속화 |
| P2 | sangfor-os-w0-w6<br>`Playground/sangfor-os-w0-w6` | `term_d4bb2736` (자율 진행) | dispatch 없음 (status 통보만) | 운영 전환 차단 결함 조사 계속 |
| P3 | u076-hardening<br>`orca/workspaces/sangfor-os/u076-hardening` | `term_ec10446c` (codex) | `task_b48b89c0282a` / `ctx_d7b5757d017e` | **완료** — 아래 참조 |
| P4 | wiki-spike<br>`orca/Wiki-spike/wiki-spike` | `term_9847a992` (claude) | `task_ae43f74d373e` / `ctx_b4f5d1765d67` | `term_48b73d39` 교착("pass three artifact") 원인 규명·해소 |
| P5 | sangfor-os<br>`Playground/sangfor-os` | `term_3b560a10` (codex) | `task_d5f86012a7da` / `ctx_88e817e02870` | 미커밋 86건 분류·WIP 보존 (최대 유실 위험원) |

부수 채널: `term_e539cb05` (P1 체크아웃에서 캡처 번들 작업 중) — 충돌 방지 통보만 발송, 지시 없음.

## 공통 금지 사항

모든 워커에게 동일하게 걸어 둔 제약:

- `git push`, PR 생성, 브랜치 변경/삭제 금지
- `git checkout` / `restore` / `clean` / `reset --hard` 등 변경 폐기 계열 명령 금지
- 증거 없는 완료 주장 무효 — 실행한 명령과 그 출력을 `worker_done` 본문에 포함

## 완료 기록

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
