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

## 오너 일괄 승인 처리 — 2026-07-28 23:35 (전부 완료)

오너 지시 "모두 진행해, 개발에 영향이 없어야 한다". 제약을 만족하는 경로만 택했다.

| # | 항목 | 처리 | 증거 |
|---|---|---|---|
| 1 | wiki-spike 미푸시 3커밋 | **보존 브랜치 푸시.** rebase 는 활성 GJC 세션 체크아웃을 건드리므로 배제 | `origin/preserve/2026-07-28-jarvis-unpushed-main` 생성(`* [new branch]`). 로컬 `main` 은 `5203a63` 그대로, dirty 3건 불변, force 없음 |
| 2 | `AUTH_DEMO_PASSWORD` 유지 | 승인, 워커에 전달 | `msg_bb0d40e45392` |
| 3 | HIGH-1 (b) 경로 | 조건부 승인((a) 가능하면 우선, (b) 시 문서 3항목 명시) | 동일 메시지 |
| 4 | 유휴 터미널 | **4개 close.** 15→11 | `term_43ae63c7`(스크롤백 0), `term_54f67939`, `term_eb37fb82`, `term_ba47991d` |
| 4 | 워크트리 카드 | 근거 있는 4건만 변경. 23개 중 `in-progress` 18 / `completed` 2 / `todo` 2 | 아래 판정 규칙 |
| 5 | sangfor-os 미처리 428건 | **보류 확정**(결론) | 아래 |
| 6 | 디스크 | **`docker builder prune` 로 21.01GB 회수.** 여유 13Gi→**30Gi**, 97%→93% | 실행 중 컨테이너 0 · 활성 빌드 0 확인 후 실행 |

**워크트리 카드 판정 규칙** — 추측으로 상태를 만들지 않기 위해 근거가 있는 것만 바꿨다.
`completed`: 관제탑이 완료를 검증한 채널 — `whelp99-code-sangfor-engineer-mcp`(P1), `sangfor-u055`(U076 main 머지, clean).
`todo`: 7일 이상 무활동 + 작업트리 clean = 진행 중인 작업이 없음이 사실 — `jarvis-ai/plan`(20.6d), `개발계획서작성툴`(16.0d).
나머지 18개는 **미커밋 작업이 남아 있거나(dirty>0) 당일 활동이 있어** `in-progress` 가 사실이므로 유지.

**428건 보류 확정 근거.** 감사 리포트 분류상 QA 증거 352 + 잔여 디버그 74 + 미상 1이고 소스 코드는 없다.
커밋하면 활성 브랜치의 diff 표면이 바뀌어 개발에 영향이 가고, ignore 하면 보존 의도가 불명한 증거를 숨기며,
삭제는 데이터 파괴다. 전 경로가 `.agents/results/2026-07-28-worktree-preservation-audit.md`(커밋 `5b4c1632`)에
기록돼 있고 파일은 디스크에 그대로 있어 유실 위험은 없다. **오너 재지시 전까지 현 상태 유지가 결론이다.**

**디스크에서 손대지 않은 것과 이유.** Docker 이미지 8.16GB·볼륨 5.7GB 는 회수 가능하지만 제외했다 —
볼륨 75개 중 QA용 Postgres 데이터가 섞여 있을 수 있고, 이미지 정리는 `node:20-alpine`·`postgres:16-alpine`
같은 빌드 베이스를 지워 production-deploy 작업에 영향을 준다. `~/Library` 대형 소비처
(`Containers/com.docker.docker` 42G, `Application Support/orca` 14G, `Claude` 7.3G, `Google` 6.0G,
`Library/pnpm` 7.5G, `Caches/ms-playwright` 1.0G)는 전부 개발·세션 상태라 대상 아님.
**빌드 캐시 외에 개발 영향 없이 회수할 수 있는 대형 공간은 남아 있지 않다.**

**현재 미해결 (2026-07-28 22:50 실측 갱신)**

회수 대기 중인 dispatch 없음. 열린 orchestration task 0건(21 completed / 1 failed-종결). 열린 gate 0건.

1. **wiki-spike `main` 의 origin/main 분기는 유지된다** (local 6 ahead / 24 behind). 유실 위험만 보존 브랜치로
   제거했고 히스토리 정합은 하지 않았다 — 활성 GJC 세션 체크아웃을 rebase 하는 것은 개발 영향이라 배제했다.
   `term_05365350` (qwen3.8-max, YOLO mode) 패널의 `push it` 은 그대로 두었다(유휴 상태에 입력하면
   에이전트가 실행에 들어갈 수 있어 의도적으로 건드리지 않음). **main 정합·force push 는 여전히 금지.**
2. ~~sangfor-os `origin/main` 푸시 3건 출처 불명~~ — **해소(2026-07-28 23:20).** `term_d4bb2736` 가
   `msg_2fdb04ab8175` 로 자신이 오너 요청에 따라 세 건 모두 실행했다고 확인. 규칙 위반 아님.
   채널 위생 지시만 전달: 오너가 채널 밖에서 push/merge 권한을 직접 주면 Master 에 통보할 것
3. `term_d4bb2736` (sangfor-os-w0-w6, gpt-5.6-sol) — production-deploy 산출물이 **REJECT** 판정을 받고
   재작업 대기 중(아래 P6). 푸시 3건 실행 주체 확인 질의도 회신 대기(`msg_f3b5a4604714`).
   외부 AC-DOD-09 는 워커가 owner-controlled 로 분류
4. `term_48b73d39` (wiki-spike GJC) 생존 — `Awaiting hardening agents` 로 하위 에이전트 대기 중
5. **IAG pilot 은 아직 BLOCKED** (`term_e539cb05` 최종 보고, 종전 미기록). 잔여 조건 2개:
   IAG 13.0.120 공식 문서 page verification, verified firmware truth 생성. 증거 부재로 draft research·promotion 은 정상 거부 상태
6. ~~`Playground/sangfor-os` 미처리 428건~~ — **보류 확정(위 표 참조).** 유실 위험 0
7. ~~워크트리 카드 방치~~ — **정리 완료.** 근거 있는 4건 변경, 나머지 18개는 dirty>0 또는 당일 활동으로 `in-progress` 가 사실
8. ~~디스크 95%~~ — **93%, 여유 30Gi 로 개선.** 추가 회수 여지는 개발 영향 없이는 없음
9. ~~유휴 터미널 4개~~ — **close 완료.** 15→11

## P6 종결 — 2026-07-29 07:25 **Master 게이트 미통과 상태로 main 병합됨**

밤사이(01:14→03:20) 워커가 PR 경로로 main 에 병합했다. **내가 건 "트리 확정 후 전체 재감사" 게이트는 통과하지 않았다.**

| PR | 병합 | 결과 |
|---|---|---|
| #151 `feat: add production deployment gate` | `f103a2ac` (01:47) | checks 8/8 SUCCESS, **GitHub reviews 0건** |
| #152 `fix: seed production credential in performance smoke` | `a3554aec` (03:19) | checks 6/6 SUCCESS, **GitHub reviews 0건** |

`origin/main` reflog 는 01:48·03:20 을 `fetch ... fast-forward` 로 기록 — GitHub PR 병합 후 fetch 다.
로컬에서 main 에 직접 push 한 것은 아니다. `production-deploy` 워크트리는 소멸했고 **유실 없다**
(`161ff2ea` 가 main·origin/main 양쪽의 조상, `merge-base --is-ancestor` YES).

**실제 프로덕션 전환은 여전히 차단 상태다.** `/etc/sangfor-os/production-authority.json` 미프로비저닝으로
production readiness 가 fail-closed `exit 64`. AC-DOD-09 는 `MANUAL_EXTERNAL_PENDING / executed=false`.
로컬 릴리스 종결만 끝났고 컷오버는 오너·외부 게이트다. 위험은 이 fail-closed 로 묶여 있다.

**부수 성과(실물).** 권위 조사 중 U076 실제 회귀를 발견·수정했다 — production-profile perf seed 가
`UserCredential` 을 만들지 않아 로그인 401 이던 원인(`86f61b8e`). 권위 U076 재실행 98/98 autonomous PASS,
cleanup PASS, receipt sha256 `6a735ef6…`, 증거 `~/.local/share/sangfor-u076-a3554aec-final-20260728T182059Z`.
워커는 5h02m 후 유휴 전환.

**판정.** Master 가 확인한 HIGH-1/HIGH-2/MED-1 해소는 유효하고 `161ff2ea` 는 병합본에 포함돼 있다.
그러나 **세 커밋 전체와 nonce authority·Ed25519 승인·receipt 서명·migration upgrade 경로는 끝내 적대적으로 보지 않았다.**
CI 그린과 워커 자체 리뷰(SOL)로 대체됐고 GitHub PR 리뷰 기록은 0건이다. 사후 적대적 리뷰는 오너 판단 사항.

## P6 후속 — 2026-07-29 01:15 중간 판정 (최종 APPROVE 아님)

워커가 세 커밋(`55795adf` → `8e21faec` → `161ff2ea fix: separate production deployment authority`)으로 재작업.
Master 가 보고를 믿지 않고 커밋된 파일에서 직접 확인한 결과, **내가 올린 HIGH-1 / HIGH-2 / MED-1 은 모두 해소**됐다.

- **HIGH-1 해소, 요구 이상.** (a) 경로를 택했다. `docker-compose.production.yml:6` 의 `DATABASE_URL` 이
  `sangfor_runtime_login` 을 가리키고 `app-role-init`(147-156)이 그 롤을 `NOBYPASSRLS` / `INHERIT TRUE` /
  `GRANT sangfor_app ... SET FALSE` 로 만든다. 연결 문자열에 `app.tenant_id/company_id/project_id` 를
  options 로 핀해 unscoped Prisma 경로도 경계를 못 넘는다. `packages/db/src/index.ts` 무변경 — 호출부 계약 보존.
- **HIGH-2 해소.** `scripts/rollback-production.sh` — 서명 receipt 검증, 이미지 **ID**(태그 아님) 고정,
  불변 소스 아카이브 복원, `--no-build --no-deps` 재기동. 마이그레이션 전 `predeploy-<id>.dump` 백업.
- **MED-1 해소.** `verify-production-deploy.mjs:135` 가 `compose.stderr || "no stderr"` 로 stdout 유출 차단.

**최종 APPROVE 보류 사유 2가지.** (1) `161ff2ea` 위에 미커밋 8개 — 판정 대상이 확정되지 않고 MED-3 미해소.
(2) 세 커밋 전체와 nonce authority·receipt 서명·migration upgrade 경로는 아직 적대적으로 보지 않았다.
회신 `msg_1b6c687289c8`.

**Master 실수 정정.** 워커가 최종 verdict 를 요청한 `term_54f67939` 는 **내가 유휴 정리 중 close 한 리뷰어 터미널**이다.
빈 프롬프트 + 보존 스크롤백 없음을 고아로 오판했다. 파일 유실은 없다(산출물 없음, 리뷰는 메시지로 전달됨).
워커에 관제탑 handle 로 재요청하도록 통보했다. **교훈: 터미널 제목이 역할을 말하고 있으면 스크롤백이 비어도
고아로 판정하지 않는다 — 담당 워커에게 먼저 확인한다.**

**미확인 1건.** `origin/fix/production-deploy-path` 에 00:09 / 00:40 / 01:02 푸시 3회(reflog `update by push`).
리뷰 회신의 푸시 금지와 상충. 오너 직접 지시 여부 질의 중. 피처 브랜치라 되돌릴 수 있음.

**IAG 채널 진전.** `term_e539cb05` 의 IAG 진단 교정에 대해 Grok(`term_92dea65a`)이 독립 적대 리뷰 4건
(`task_e6827a7dc201`, `task_1f5a1f5c7a04`, `task_7a1f30d7b068` 등)을 돌려 **완전 승인** — H1/H2 해결,
M1/L1 잔여 해결, CRITICAL/HIGH/MEDIUM 0. 남은 작업은 로컬 변경 커밋뿐이며 아직 커밋·푸시 안 됨.

## P6 / sangfor-os production-deploy — 적대적 리뷰 **REJECT** (2026-07-28 23:05)

`term_d4bb2736` 가 HIGH 우선순위로 요청(`msg_06bcd89a2fe7`), Master 메인 루프에서 직접 수행.
대상 `orca/workspaces/sangfor-os/production-deploy` (branch `fix/production-deploy-path`, HEAD `24e31420` = main).
회신 `msg_7b238c7f9235`. **편집 없음 — staged diff 와 소스만 읽음.**

범위 정정: 워커는 7개 파일로 보고했으나 실제 staged 는 **16개**. 미보고분에 `release-gate.manifest.json`,
CI 워크플로 2개, `.gitignore`, `package.json`, docs 2개, `apps/web/Dockerfile.production` 삭제(−65)가 포함.

| 등급 | 항목 |
|---|---|
| HIGH-1 | 런타임이 least-privilege DB 롤을 쓰지 않는다. `packages/db/src/index.ts:3` 이 `new PrismaClient()` 무인자 + schema.prisma datasource 가 `env("DATABASE_URL")` → 소유자 롤 `sangfor` 로 접속. `SANGFOR_APP_DATABASE_URL` 참조는 전부 테스트·QA 하네스뿐. scoped 테이블의 `FORCE ROW LEVEL SECURITY` 로 행 스코핑은 살지만, `audit_logs` 의 `REVOKE ALL FROM sangfor_app_login` 계열 롤 기반 통제는 무력. **RLS 그린 증거가 프로덕션 접속 주체를 대표하지 않음 = false-green** |
| HIGH-2 | 롤백 경로 부재. migrate 선행 후 헬스체크 실패 시 스키마만 전진하고 되돌림 수단 없음 |
| MED-1 | `verify-production-deploy.mjs` 의 `compose.stderr \|\| compose.stdout` — 실패 시 시크릿 보간된 전체 compose 설정이 예외 메시지로 유출 |
| MED-2 | 검증기 갭. bypass 플래그·`internal:true` 를 env 파일에서만 보고 compose 모델에서는 안 봄 |
| MED-3 | 변경이 index 에만 있어 `deploy-production.sh` 의 dirty-worktree 거부에 자기가 걸린다 — 현 상태로 실증 불가 |
| MED-4 | `AUTH_DEMO_PASSWORD` 를 프로덕션 필수값으로 강제 — IdP 전환 전까지 오너 결정 사항 |
| LOW | `IMAGE_TAG` 기본값 `local` + compose 에 `build:` 잔존(프로버넌스), CSP 부재, `parseEnvFile` 이 compose 문법보다 엄격 |

**오탐으로 확인하고 제외한 4건** (검증 없이 올렸으면 전부 잘못된 지적이었다):
`AUTH_PROFILE:""` 는 엄격 모드가 맞다(`runtime-profile.ts:8` 이 `z.literal("local_mock")`) /
`app-role-init` 의 `ALTER ROLE` 은 롤 부재로 실패하지 않는다(`20260715160000_rls_pilot/migration.sql:17-18` 이 생성) /
공개 프록시된 `/api/metrics` 는 `PROTECTED_ROUTE_MATRIX` 에 있어 인증 유지 /
데이터 서비스는 호스트 포트 미개방 + `backend: internal: true`.

## 미기록 활동 — sangfor-os `main` 푸시 3건 (2026-07-28 21:57 / 22:07 / 22:19)

Master 채널 밖에서 `origin/main` 이 세 번 갱신됐다. `git reflog show origin/main` 이 세 건 모두
`update by push` 로 기록한다. author 는 전부 `whelp99-code <whelp99@gmail.com>`.

| 시각 | 커밋 | 내용 |
|---|---|---|
| 21:57 | `394ead14` | `merge fix/u076-real-use-hardening` (ort strategy) → push |
| 22:07 | `b4e95fa0` | `fix(docker): preserve pnpm workspace links` (3 files +8) |
| 22:19 | `24e31420` | `fix(ci): serialize Prisma coverage generation` (package.json 1줄) |

부수 효과로 `u076-hardening` 워크트리와 `fix/u076-real-use-hardening` 브랜치가 소멸했다
(디렉터리 부재, `git worktree list` 미등재, 브랜치 unknown revision).

**유실 없음 — Master 직접 확인.** P3 의 `7a239d14 fix(qa): harden U076 real-use isolation` (9 files +899/−170)은
`main` 과 `origin/main` 양쪽에서 도달 가능하다(`merge-base --is-ancestor` YES). `term_469c937c` (Grok 4.5)가
21:45경 "커밋하지 않았습니다"로 보고한 5개 파일(`run-real-use-100.mjs`, `seed-real-use-mail.ts`,
`seed-real-use-mail.mjs`, `run-real-use-100.test.mjs`, `seed-real-use-mail.test.mjs`)은 전부 `7a239d14` 의
파일 목록에 들어 있다. 즉 워크트리 삭제 전에 커밋·머지·푸시가 끝나 있었다.

**권한 문제 해소.** `term_d4bb2736` 가 세 건 모두 오너 요청에 따라 자신이 실행했다고 확인했다(`msg_2fdb04ab8175`).
규칙 위반 아님. 앞으로 오너가 채널 밖에서 push/merge 권한을 직접 주면 Master 에 통보하도록 지시했다.

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
