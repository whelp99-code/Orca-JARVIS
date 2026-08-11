# JARVIS 관제탑 — 채널 레지스트리

이 리포지터리는 코드를 담지 않는다. JARVIS Master(사람 ↔ 프로젝트별 메인 에이전트)의 **소통 창구**다.
운영 규율은 [ORCA_MASTER_CHARTER.md](ORCA_MASTER_CHARTER.md)를 따른다.

- 관제탑 터미널(coordinator handle): `term_8ea40ebd-9369-4ff2-b24a-e6f63b9a8648` (`GJC: Orca-JARVIS`,
  `/Volumes/DevSpace/Orca-JARVIS`) — **2026-08-06 실측 확인**(connected/writable).
- 모든 워커는 `worker_done` / `escalation` / `ask` 를 `term_8ea40ebd-9369-4ff2-b24a-e6f63b9a8648` 로 보낸다.
- 핸들 이력(전부 사망):
  - `term_681e162b-c9df-4955-b70d-f0ab110baf7e` — 2026-07-29~08-06 사용. `orca terminal show` 가
    `terminal_handle_stale` 반환(2026-08-06 실측).
  - `term_771c9810-de0c-4323-a90d-de30f6cef334` — 2026-07-28 사용. Orca 재시작으로 실효.
  - 채널 맵의 워커 핸들(`term_92dea65a`·`term_d4bb2736`·`term_9847a992`·`term_ec10446c`·`term_3b560a10`·
    `term_a8102741`·`term_e539cb05`·`term_48b73d39`)도 2026-08-06 터미널 목록에 일치 항목이 하나도 없어
    전부 실효. 새 채널 맵은 아래 "채널 맵 — 2026-08-06" 절.
  - **교훈(실사고): Orca 재시작 후에는 관제탑이 가장 먼저 자기 핸들을 재확인해야 한다.** 핸들이 죽은 사이
    워커의 blocking 질문이 닿지 않아 pre-commit 게이트가 600초 타임아웃됐고, 워커의 `worker_done` 도
    pane 불일치로 Orca 에 거부됐다. 워커는 게이트를 우회하지 않고 재발행하며 대기해 피해가 없었다.
    `orca terminal read` 가 `terminal_handle_stale` 을 반환하면 즉시 전체 핸들을 재조사한다.
- 개설: 2026-07-28

## 세션 재개 (새 세션은 이 절만 읽으면 된다)

컨텍스트 비용 때문에 관제탑 세션은 자주 비운다. 새 세션은 아래 프롬프트로 시작한다.

```
ORCA_MASTER_CHARTER.md 와 CONTROL_TOWER.md 를 읽고 JARVIS Master 로 이어받아라.
추측으로 상태를 만들지 말고 실제 Orca 상태를 읽어라. 미해결 항목부터 보고해.
```

## 2026-08-10 실측 갱신 및 오너 지시 반영

1. **JM-AI Action Hub 완전 동기화 및 해소**:
   - 2026-08-09 PR #2~#8 완결 (모바일 Focus 워크플로우 `5e435a0`, 음성 입력 크래시 수정, KeyChain 스탈 크레덴셜 해소, 249개 테스트 통과 — 2026-08-09 기록, 2026-08-10 세션에서는 재실행하지 않음).
   - 2026-08-10 로컬 리포지토리 `git pull` 완료 (05034e7 -> 5e435a0 fast-forward). Action Hub의 이전 미해결/PENDING 항목 해소 확인.
   - 2026-08-10 12:54 KST 재실측: `main` @ `5e435a0`, `origin/main` 0/0, porcelain clean.
2. **`pelican` 워크트리 및 브랜치 제거**:
   - 오너 방침 ("서브 브랜치/D-1 불필요, `main` 단일 브랜치만 사용")에 따라 `pelican` 워크트리 및 브랜치를 완전히 제거함.
   - `Orca-JARVIS`는 단일 `main` 브랜치. remote: `https://github.com/whelp99-code/Orca-JARVIS` (2026-08-10 서버이전 MUST 처리 시 생성·푸시).
3. **`sangfor-os` canonical 메인 저장소 동기화 완결 확인**:
   - 커밋 그래프: `main` @ `72fe1f1` (PR #197), `origin/main` 0/0 — 동기화 맞음.
   - **정정(2026-08-10 12:54 KST):** 오전 장부의 "100% clean"은 과대 선언이었다. 미추적 `artifacts/disappointment-test-20260805/`가 남아 있었음. 로컬 QA 덤프로 확인 후 삭제하여 porcelain clean 복구.

## 2026-08-10 서버이전 MUST 일괄 처리 (오너 승인 실행)

인벤토리 `docs/MIGRATION_PREFLIGHT_GIT_INVENTORY.md` 의 MUST 10항을 처리했다. 상세 표는 해당 문서.

### 완료 요약

| # | 대상 | 결과 |
|---|------|------|
| 1 | engineer-mcp | PPTX 원복, `feat/plan-closeout` 푸시, **PR #12** |
| 2 | wiki-spike | `docs-root-cleanup` 푸시(0/0), collector dirty 커밋·푸시(`baf6c9e`), trevally 푸시, **PR #61** 존재 |
| 3 | EvoHarvest | `.DS_Store` 패키징 제외 커밋 `3bd2bb4` + hardening 푸시 0/0 |
| 4 | Master Worker | EvoHarvest receipt 고정 커밋 `f58550c` → **main 푸시** 0/0 |
| 5 | sangfor-os | unmerged/gone 로컬 브랜치 **15개 재푸시** (codex-spark-llm, daggertooth, mfa-totp, finance/mail fix 등). main 0/0 clean |
| 6 | Orca-JARVIS | private remote 생성·`main` 푸시 0/0 |
| 7 | BLRO-Website-source | content 커밋 `7452047` → main 푸시 0/0 |
| 8 | loop-engineering-labs | 로컬 커밋 `e56ede0`; upstream `Q00/*` 403 → **`whelp99-code/loop-engineering-labs` 미러 푸시** |
| 9 | blro-preview | 로컬 커밋 `0503a03`; `sites-preview` 인증 실패 → **`whelp99-code/blro-homepage-sites-preview` 미러 푸시** |
| 10 | no-remote 미러 | me-wiki, ProofGraph-Graph-Native-v7, AI_Supporter, orca-DEV, app-dev-manager private 생성·푸시. controller `gitgauge` main +2 푸시 |

### 아직 남은 것 (MUST 밖 / 후속)

1. wiki-spike **PR #61 머지 여부** (main 통합) + untracked artifacts 21 정책
2. engineer-mcp **PR #12 머지 여부**
3. EvoHarvest/Auto Work **hardening → main 머지** 여부
4. sangfor-os 재푸시 브랜치들의 **PR/머지 or 보존 보관** 결정
5. blro-preview **sites-preview 원격 인증 복구** 후 동일 커밋 재푸시
6. AI_Supporter 등 일부 **untracked 로컬 잔여** (`.agents`/`.gjc`/docs) — tip은 미러됨
7. Action Hub 249 tests 재실행, stale worktree 삭제 (Phase D)
8. AI-Engine 576 dirty / Documents_Playground 대량 dirty (비-MUST)

### 데몬

- `node dist/src/cli.js service run --interval-ms 10000` + LaunchAgent `com.jmpark.orca-jarvis` 가동 확인.
- `live_supervisor_worktrees` 5경로 등록(engineer-mcp, Orca-JARVIS, loop-engineering-labs, wiki-spike, JM-Loop-Miner). 터미널 개수는 Orca 라이브 목록과 1:1 고정이 아님.



## 2026-08-11 — 이중 Orca 환경 관제 (local + jm-server)

- **문서:** [docs/dual-environment-monitoring.md](docs/dual-environment-monitoring.md)
- **환경 등록명:** acloud Orca = `jm-server` (`ws://100.87.81.57:6769/` Tailscale)
- **브리핑:** LOCAL / JM-SERVER 섹션을 분리해 실측. 로컬 결과로 원격을 추정하지 않음.
- **데몬:** `ORCA_JARVIS_ENVIRONMENTS=local,jm-server` (기본). `project discover` 가 양 호스트 바인딩 등록. 원격 경로 인코딩 `/orca-env/jm-server/...`. worktree 상한 10.
- **원격 실패 정책:** multi-env discover 시 jm-server 불가여도 local 은 계속.

### 2026-08-11 14:16 KST — 데몬 사망/복구 실측 (관제탑 인수 브리핑)

- **사고:** `service run` 데몬 프로세스 0개 (nohup 프로세스 소멸, launchd 미등록). `service.err.log` 마지막 기록 13:47.
- **원인 1 (CLI 실패, 이후 정정):** 최초에는 `better_sqlite3.node` 와 plist 지정 node(`~/.local/bin/node` v22.23.1, ABI 127)를 맞춰 CLI만 복구했으나, `package.json`의 운영 계약은 Node `>=24`이다. 아래 2026-08-12 정정에서 Node24/ABI137로 최종 복구했다.
- **원인 2 (launchd I/O error 5):** plist 를 외장 볼륨 경로(`.jarvis-runtime/...plist`)에서 bootstrap 하면 실패. → **`~/Library/LaunchAgents/com.jmpark.orca-jarvis.plist` 로 복사 후 bootstrap 성공.** 이후 launchd 재등록은 이 경로 사용.
- **복구 실측:** launchd state=running, pid 87171, KeepAlive, `ORCA_JARVIS_ENVIRONMENTS=local,jm-server`. 가동 25초(2+사이클) 후 err.log 신규 기록 0건. `report status`: worktrees 9, bindings 14 (local 12 + jm-server jm-loop-miner 2), reports_pending 1.
- **이중 호스트 실측:** LOCAL v1.4.179 ready, 터미널 20, 워크트리 20. JM-SERVER ready, 터미널 5(engineer-mcp 2·jm-loop-miner 2·sangfor-os 1), 워크트리 8.

### 2026-08-12 00:41 KST — 고CPU 원인 확정 및 Node24 복구

- **증상 실측:** Node22 PID 87171의 main thread가 반복 측정에서 CPU 66.9~96.3%, 10시간 이상 runnable 상태였고 SIGTERM에도 종료되지 않았다.
- **확정 원인:** launchd가 manifest 계약(Node `>=24`) 밖인 v22.23.1로 서비스 실행. 동일 DB·환경·10초 interval에서 Node24.19.0/ABI137로 전환하자 20초 연속 샘플 모두 CPU 0.0%, sleeping.
- **복구:** 두 plist의 실행 경로를 `/Users/jmpark/.nvm/versions/node/v24.19.0/bin/node`로 변경하고 better-sqlite3를 ABI137로 rebuild. launchd PID 21274로 재기동.
- **report delivery 복구:** `service run`이 delivery JSON을 stdout에 기록한 뒤 ACK하도록 수정. 실환경에서 `live_report_db75...` 출력 후 DB가 pending 1/delivered 1 → pending 0/delivered 2로 전환했고, 다음 사이클에서 cursor 14개 갱신·delivered 3을 확인해 관측 재개를 검증했다.
- **최종 데몬:** Node24 launchd PID 72740. 12초 표본 CPU 0.0~1.7%(사이클 시점), sleeping, reports_pending 0.
- **검증:** focused 회귀 1/1, lint/typecheck, migration-count 테스트를 제외한 87/87, pre-GJC acceptance, build, CLI smoke 통과. 독립 reviewer 1차 REJECT(출력-before-ACK 테스트 공백) 반영 후 2차 APPROVE. 기존 `migrations.test.ts`는 migration 020이 이미 존재하지만 기대값이 19라 1건 실패(이번 변경과 무관).

## 2026-08-10 MUST 후속 — PR 머지 + hardening main + worktree 청소

### 1. PR 머지 (완료)

| PR | 결과 |
|----|------|
| engineer-mcp **#12** | MERGED → main `5b85c50` (CI verify/validate green) |
| wiki-spike **#61** | MERGED → main `92670af` (G3/G4/preflight green) |

### 2. hardening → main (완료)

| 저장소 | PR | main tip |
|--------|-----|----------|
| EvoHarvest | **#2** MERGED | `e13910b` |
| JM-AI Auto Work OS | **#2** MERGED | `da97a26` |

### 5. Phase D worktree 청소 (완료)

제거 (remote 브랜치 보존 또는 main 흡수 후):

- sangfor-os: daggertooth, u076 attempt, main-fork(force·로컬 dirty 폐기), u076-main-8d83d2b9(force), loop-graph-pr001(force)
- engineer-mcp: ooo/orch ratfish, ratfish worktree(force) + merged 로컬 브랜치 8개 삭제
- Action Hub: real-device-qa, weever + weever 로컬 브랜치 삭제
- wiki-spike: trevally, ooo/orch, qwen-works(force)

**유지:** `wiki-spike-collector` @ `second-brain-operational-authority-adapter` (main 미머지 작업 브랜치, clean)

### 아직 미실행 (설명만)

- **3** sangfor-os 재푸시 15 브랜치 PR/보관 정책
- **4** blro-preview `sites-preview` 원격 인증



### 4. blro-preview `sites-preview` (2026-08-10 처리 결과)

- **GitHub canonical:** `origin`/`github` → `whelp99-code/blro-homepage-sites-preview`, tip `0503a03`, 0/0.
- **sites-preview 직접 푸시:** 불가 확인. Keychain 없음; Codex OAuth access/id/refresh 로 `git.chatgpt-team.site` 인증 실패(`Authentication required`). Sites는 ChatGPT 세션 **단기 자격증명** 경로.
- **문서:** 로컬 `docs/SITES_PREVIEW_REMOTE.md` — ChatGPT Sites UI에서 save version / deploy.
- **서버 이전 영향:** 소스 유실 없음. 호스팅 프리뷰 URL만 구버전일 수 있음 → 오너가 Sites UI에서 배포.


## 2026-08-06 실측 갱신 (문서 공백 8일 — 상태 재조사)

문서 최종 커밋 `53883af`(2026-07-29 10:43) 이후 관제탑 기록이 멈춰 있었다. 2026-08-06 23:16 KST 기준
Orca 실측으로 재조사한 결과다. 과거 절은 보존하며, 이 절이 현 상태의 정본이다.

**관제탑 핸들.** `term_681e162b` 사망 확인(`terminal_handle_stale`). 현 핸들
`term_8ea40ebd-9369-4ff2-b24a-e6f63b9a8648`. 2026-07-29 교훈 절차 그대로 — 재시작 후 핸들 재확인.

**터미널.** 라이브 **43개** (마지막 정리 시점 11개). 경로별 분포 실측(23:24 스냅샷 — 라이브 환경이라
수치는 계속 움직임. 23:16 측정 40개 → 23:24 측정 43개):

| 수 | 경로 | 비고 |
|---|------|------|
| 14 | `Playground/JM AI-OS Pack/JM-AI Master Worker` | 문서 미기록 워크스트림 |
| 4 | `Playground/whelp99-code-sangfor-engineer-mcp` | 오늘 PR #11 머지(19:30) |
| 4 | `Playground/ProofGraph-Graph-Native-v7.0.0` | 문서 미기록 |
| 4 | `Playground/JM AI-OS Pack/JM-AI Action Hub` | 아래 Run 3개 참조 |
| 3 | `~/Downloads/01.Pilot_Coding/jarvis-ai` | 문서 미기록 |
| 2 | `Playground/sangfor-os` | 오늘 `feat/codex-spark-llm` ADR-008 커밋 |
| 2 | `Playground/JM AI-OS Pack/EvoHarvest` | 문서 미기록 |
| 2 | `orca/Wiki-spike/wiki-spike` | 오늘 `docs-root-cleanup` DB-05 커밋 |
| 2 | `orca/workspaces/sangfor-os/daggertooth` | 문서 미기록 워크트리 |
| 4 | `Projects/ITAC-security-essentials` | 문서 미기록 |
| 1 | `Orca-JARVIS` | 관제탑 자신 |
| 1 | `Playground/JM AI-OS Pack/JM-AI Auto Work OS` | 문서 미기록 |

**오케스트레이션 Run.** `run-list` 실측 — JM-AI Action Hub Phase 1·2·3 Run 3개가 2026-08-02 생성돼 있다
(`run_21bd633062ba`, `run_4efa4f962b2c`, `run_b7a9c71893ad`). 설명에 `LIVE-ACCEPTANCE PENDING`,
`iOS-XCTEST PENDING`, `CARD-03-03 prohibited`, 커밋·푸시·서명 금지가 명시. 상세 조사는 진행 중(아래 Run
상태 절에 기록 예정). legacy Run 2개(`run_legacy_local`, `run_05827a48b020`)는 조회 전용.

**자동화.** `JARVIS Morning Brief` enabled — 주중 09:00, next run 2026-08-07 09:00 KST 실측. 정상.

**디스크.** `/Volumes/DevSpace` 여유 **139Gi, 31% 사용** 실측. 문서의 "93%·여유 30Gi" 서술은 구 정보다.

**옛 미해결 목록의 현 상태.**

1. wiki-spike `main` 분기(6 ahead / 24 behind) — **아래 "현재 미해결 — 2026-08-06" 절에서 0/0 으로 해소 확인.**
   기록 시점 이후 워크트리·브랜치가 움직였고(`docs-root-cleanup`, `second-brain-operational-authority-adapter`
   워크트리 실존), 정합·force push 금지 지시는 그대로 유효.
2. P6/P8 계열(`term_d4bb2736`/`term_a8102741`) — 핸들 전부 실효. sangfor-os 는 main-fork `20dbc00`
   (#165, 07-31)로 이동했고 Playground/sangfor-os 는 별도 브랜치 작업 중. U076·리허설 라인의 완결 여부는
   리포 실측으로 재확인 필요.
3. `term_48b73d39` (wiki-spike GJC) — 핸들 실효. wiki-spike 작업은 다른 체크아웃에서 지속 중.
4. IAG pilot BLOCKED — 해당 채널(`term_e539cb05`) 실효. 잔여 조건 2개(13.0.120 문서 검증, firmware
   truth)는 오너 재지시 전까지 상태 변화 없음으로 기록.
5. 옛 채널 맵의 터미널·task·dispatch 좌표는 전부 구 핸들이라 실효. **새 채널 맵은 아래
   "채널 맵 — 2026-08-06 (정본)" 절에 작성 완료** — 위생 분류(35개) 기준 + 08-07 00:5x 신규 2 = 37.

**이 리포(실측).** Orca-JARVIS 는 `main` 브랜치, 원격 없음. 조사 시점의 미추적 잔여
(`.DS_Store`, `.gjc/`, `.serena/`, `PROJECT_INVENTORY.md`)는 아래 "현재 미해결 — 2026-08-06" 7번에서
`.gitignore` 추가 + 인벤토리 커밋으로 처리 완료.

## 터미널 위생 분류 — 2026-08-06 23:51 (43 → 35)

라이브 터미널 43개 전수를 `terminal list` 메타데이터(제목·orphaned·preview)와 `terminal read`
스크롤백 실측으로 분류했다. 판정 규칙(2026-07-28): 스크롤백 0 + 역할 제목 없음 + 유휴만 close.

**측정 실수 정정.** 첫 스크롤백 측정이 응답 필드를 잘못 읽어(`lines` 대신 `tail`·`returnedLineCount`가
정답) 후보 12개 전부 0으로 잘못 보고됐다. 재실측에서 고아 4개가 81–85행(약 4천 자) 스크롤백 보유로
드러나 close 대상에서 제외했다. 잘못된 측정 기반 close 는 실행 전 차단됨.

**close 실행 — 8개.** 전부 스크롤백 0행 0자 + 제목 없음 실측 확인 후 실행:

| 핸들 | 경로 | 결과 |
|------|------|------|
| `term_975d1adc` | jarvis-ai | `tab_not_found` (목록에서 제거 확인) |
| `term_09538a61` | jarvis-ai | Closed, PTY killed |
| `term_b203719d` | jarvis-ai | Closed, PTY killed |
| `term_cb33ff4d` | JM-AI Action Hub | Closed, PTY killed |
| `term_0d320713` | JM-AI Action Hub | Closed, PTY killed |
| `term_26985e38` | JM-AI Action Hub | `tab_not_found` (목록에서 제거 확인) |
| `term_0fdaa32f` | JM-AI Action Hub | Closed, PTY killed |
| `term_9f5d6281` | JM-AI Auto Work OS | Closed, PTY killed |

close 후 재실측: **35개** (43 − 8 = 35 정확히 일치. 8개 전부 목록 소멸 확인).

**활성 — 7개 (에이전트 실행 중, 보존):**

| 핸들 | 제목 | 경로 | 근거 (preview 실측) |
|------|------|------|---------------------|
| `term_8ea40ebd` | GJC: Orca-JARVIS | Orca-JARVIS | 관제탑 자신 — Working |
| `term_deef777e` | GJC: whelp99-code-sangfor-engineer-mcp | engineer-mcp | Working |
| `term_f0228f8d` | GJC: ProofGraph-Graph-Native-v7.0.0 | ProofGraph | Awaiting terminal critic |
| `term_3c8996d3` | GJC: JM-AI Master Worker | JM-AI Master Worker | Working |
| `term_3cb5cd37` | GJC: daggertooth | sangfor-os/daggertooth | Reading opencode client config |
| `term_7ea47317` | GJC: wiki-spike | wiki-spike | Measuring time and evidence digests |
| `term_e24ff067` | WinRM 및 로그 전송 보안 검토 | ITAC-security-essentials | 실행 중(3m38s·↑14k tokens) |

**고아·보존 — 4개 (JM-AI Master Worker):** `term_6b919fdc`·`term_98d042ef`·`term_d335a24c`·
`term_af98ddcc`. `orphaned=true` 지만 스크롤백 81–85행 보유라 규칙상 close 불가 — 내용 보존 필요.
워커 산출물 여부 확인 후 오너가 폐기 결정.

**유휴·보존 — 24개 (제목 또는 스크롤백 있음):**

| 핸들 | 제목 | 경로 |
|------|------|------|
| `term_46a70d8e` | ..-engineer-mcp | engineer-mcp |
| `term_b01ef450` | ✳ DB 데이터 저장 방식 및 에이전트 지원 분석 | engineer-mcp |
| `term_a1567c30` | Pi | engineer-mcp |
| `term_f0c76126` | ✳ 현재 프로젝트 상황 파악 | ProofGraph |
| `term_d140f743` | OMP ready | ProofGraph |
| `term_b05edcac` | PiDelegatedAdapter per-call 옵션 구현 | ProofGraph |
| `term_59cc4d8a` | Pi | Playground/sangfor-os |
| `term_a5f3f8e3` | ..nd/sangfor-os | Playground/sangfor-os |
| `term_bd52fc29` | OMP ready | JM-AI Master Worker |
| `term_3f3dc40c` | Pi | JM-AI Master Worker |
| `term_c0970dd9` | ✳ 마스터 이전 내용 파악 및 작업 진행 | JM-AI Master Worker |
| `term_e82a350d` | 인증 점검 핑 테스트 | JM-AI Master Worker |
| `term_11297c57` | Auth Check Ping READY-GROK Test - grok | JM-AI Master Worker |
| `term_28e4563c` | agy | JM-AI Master Worker |
| `term_58238a0c` | ..Master Worker | JM-AI Master Worker |
| `term_80dc1dfc` | ..Master Worker | JM-AI Master Worker |
| `term_9aedd9a0` | ✳ Explore | JM-AI Master Worker |
| `term_430e16f5` | ✳ 마스터 오퍼레이터 통신 테스트 | EvoHarvest |
| `term_1d2481f3` | ✳ 마스터 오퍼레이터 통신 테스트 | EvoHarvest |
| `term_a037116f` | Pi ready | wiki-spike |
| `term_93681fc7` | ✳ ITAC 보안 필수사항 점검 계획 수립 | ITAC-security-essentials |
| `term_d8d11467` | Qwen - ITAC-security-essentials | ITAC-security-essentials |
| `term_e6b32cd3` | ..ty-essentials | ITAC-security-essentials |
| `term_3dbc58db` | ..s/daggertooth | sangfor-os/daggertooth |

검산: 활성 7 + 고아 4 + 유휴 24 = 35 = close 후 실측 수.

## JM-AI Action Hub Run 3개 상태 — 2026-08-06 실측 (읽기 전용 조사)

2026-08-02 생성된 Phase 1–3 Run 을 `run-show`·`task-list --run`·`gate-list --run`·`dispatch-show` 로
조회했다(바인딩 변경 없음). 결정 게이트는 3개 Run 전부 **0건** — PENDING 항목들은 게이트가 아니라
Run 목적문·분류 텍스트다. 리포 체크아웃(`jm-ai-action-hub-focus-suite-v0.9.0-ios-v0.2.1`, 브랜치
`hardening/local-complete-20260804`, porcelain clean)의 `evidence/` 로 교차 확인했다.

| Run | 단계 | 좌표 터미널 | 태스크 현황 |
|-----|------|------------|-------------|
| `run_21bd633062ba` | Phase 1 | 해제됨(null) | 7/7 completed |
| `run_4efa4f962b2c` | Phase 2 | 해제됨(null) | completed 6 / blocked 2 / failed 1 (아래 참조) |
| `run_b7a9c71893ad` | Phase 3 | `term_666865d2` — **사망**(`terminal_handle_stale` 실측) | completed 2 / failed 3 (아래 참조) |

**Phase 1 — 종결.** CARD-01-01~04 전부 completed. 추가 조치 없음.

**Phase 2 — 실질 종결, 원장에 잔여 상태 3건.**
- `CARD-02-03`(blocked)·`CARD-02-03-R1`(blocked)은 **원장 잔여**다. 당시 워커가 범위 밖 전제조건
  (root LICENSE·NOTICE 부재, `.env.example` 에 `ACTION_HUB_MOBILE_RECOMMENDED_IOS_APP_VERSION` 부재)으로
  에스컬레이션 후 응답을 못 받아 막혔으나(`msg_1ee9ae52ed43`), 후속 `CARD-02-03-R2` 가 fail-closed
  정정으로 **completed** — 앞선 blocked 2건은 대체된 상태다.
- `CARD-02-04 remainder`(failed)는 소유 범위 밖 Ruff 11건에 막혔으나 `CARD-02-04-R1` 이 **completed** 로 닫음.
- Wave 02 LunaMax revision R2 completed.

**Phase 3 — 로컬 완료, 원장과 디스크 증거가 불일치한다.**
- `CARD-03-01` completed(backup/restore 하드닝·리허설). `CARD-03-R1` 첫 시도 failed 후 재디스패치 completed.
- `CARD-03-02`(failed) 보고는 `verify.sh`=4 였다 — conftest import 시 `StarletteDeprecationWarning` 승격.
  **이건 이후 해소됐다**: 디스크의 R2 독립 검증(`evidence/lunamax-wave03-final-r2-review.md`)이 `verify.sh`=0
  (174 passed, 83.17%, `VERIFY_OK`), `make verify`=0, acceptance-local 기준 1–5 PASS
  (`LOCAL_PASS_EXTERNAL_PENDING`)를 실측으로 기록했다.
- `CARD-03-R2`(failed, `last_failure="stopped"`)는 디스패치가 1분47초 만에 멈췄지만 **실제 작업은 수행됐다** —
  워커(`/root/wave03_r2_terra`, gpt-5.6-terra)가 R2 를 끝냈고 `evidence/wave-03-final.json`(21:51)이
  `DONE_LOCAL_PASS`, 초기 HIGH 2·MEDIUM 2 전부 CLOSED 를 기록. **원장의 failed 는 디스패치 정지 사고고,
  디스크 증거는 PASS.** 좌표 터미널 사망으로 원장 정정이 안 된 채 남아 있다.

**남아 있는 실제 게이트 2개 (코드 문제가 아님).**

1. **iOS-XCTEST PENDING** — `ios/scripts/verify_release.sh`=1, 유일한 실패가 `no such module XCTest`.
   Xcodeproj/OpenAPI/static 검사는 전부 PASS. 이 호스트에 전체 Xcode 가 없어 XCTest 빌드가 불가한
   **환경 부재**다. 오너 결정: 전체 Xcode 설치 후 재실행, 또는 pending 수용 명시.
2. **LIVE-ACCEPTANCE PENDING / CARD-03-03 금지** — `evidence/production-acceptance-20260802T203926Z.json`
   의 유일한 blocker 가 `LIVE_ACCEPTANCE_PENDING (사용자 인프라 필요)`. 기준 1–5는 전부 PASS(각 SHA-256
   바인딩). CARD-03-03 은 Run 목적문에서 에이전트 실행이 금지돼 있다 — 오너의 라이브 인프라·인간 승인
   일정만 남았다. 경로: `docs/operations/ACTION_HUB_PRODUCTION_ACCEPTANCE.md`.

**오너 결정 필요.**
- Run 3개 종결 처리: Phase 1·2 는 좌표 해제 상태로 사실상 종결. Phase 3 은 좌표 터미널 사망 + 원장
  불일치(디스크 PASS vs 원장 failed)라, 새 좌표를 바인딩해 원장을 증거에 맞게 정정하거나 종결 선언 후
  아카이브하는 판단이 필요하다. 본 조사는 읽기 전용이라 Run·태스크 상태를 건드리지 않았다.
- iOS 전체 Xcode 설치 여부.
- 라이브 인수(CARD-03-03) 일정.

**참고(실측).** 리포 브랜치는 08-04 이후 추가 커밋(improvement plan v2, B-01 master-worker completion
pull channel 등)으로 이동 중이며 JM-AI Master Worker 터미널 14개가 이 계열 작업이다. Wave 03 당시
`UNCOMMITTED_WORKTREE` 였던 산출물은 현 브랜치에 커밋돼 있고 워크트리는 clean 이다.

## 현재 미해결 — 2026-08-06 (07-28 목록 대체)

아래 표는 전부 `git fetch` 후 실측한 값이다. 07-28 "현재 미해결" 목록은 아래 절에서 원문 보존하되
이 절로 대체됐다(표시 추가). merge·rebase·push 없이 조사만 했다.

**리포 스냅샷 (vs origin/main):**

| 리포 / 체크아웃 | 브랜치 | ahead/behind | dirty | 비고 |
|-----------------|--------|--------------|-------|------|
| wiki-spike 메인 체크아웃 | `docs-root-cleanup` | 2/0 | 미추적 4 | **`main` 은 origin/main 과 0/0 — 옛 "6 ahead / 24 behind" 분기 해소됨.** 미푸시 2: `1264a1b`(DB-05 shadow window), `71ae623`(status reports 이동) |
| wiki-spike-collector 워크트리 | `second-brain-operational-authority-adapter` | 미대조 | 12 | tip `c2be765`(08-01) |
| sangfor-os main-fork | `local-recovery/main-fork` | 0/**28** | 58 (M30/D18/??10) | 원격 최신 28커밋 미반영. dirty 최대: `services/production-nonce-authority` 13, `apps/web` 6, `.claude/skills` 4 |
| Playground/sangfor-os | `feat/codex-spark-llm` | **10**/0 | 미추적 1 | 미푸시 10: ADR-008 RLS 스코프 계약, replay 리포트, finance 챗봇 OPENAI_BASE_URL, 토큰 상한, U073 unscoped 면제 등 |
| sangfor-os daggertooth 워크트리 | `whelp99-code/daggertooth` | 미대조 | 1 | tip `a95cc66` = #194 Codex Spark 배선(08-05) |
| sangfor-engineer-mcp | `feat/plan-closeout`(=origin/main) | 0/0 | M3 + 미추적 2 | 오늘 PR #11(officecli-documents) 머지. dirty: AGENTS.md·PPTX·tsconfig |
| Action Hub 체크아웃 | `hardening/local-complete-20260804` | — | 0 | Run 상태 절 참조 |
| Orca-JARVIS | `main` | 원격 없음 | 미추적 4 | 이 리포. `pelican` 은 별개 워크트리(`/orca/workspaces/Orca-JARVIS/pelican`, dirty 1) |

**미해결 항목.**

1. **sangfor-os main-fork 동기화 판단 필요.** 28커밋 뒤처졌고 dirty 58 중 삭제 18·수정 30이
   nonce-authority·web 에 집중돼 있다. 섣부른 pull/checkout 은 금지(공통 금지 사항). dirty 분류 후
   fast-forward 가능 여부·충돌 범위를 오너가 판단한다.
2. **Playground/sangfor-os 미푸시 10커밋.** push 금지 규칙으로 보존 중. 단, codex-spark 작업 일부가
   daggertooth 경유 #194 로 upstream 에 이미 머지돼 있어 브랜치와 upstream 간 중복 범위 대조가 필요하다.
3. **wiki-spike `docs-root-cleanup` 미푸시 2커밋.** push 판단 대기. 옛 미해결 1번(main 분기)은 해소로 종결.
4. **JM-AI Action Hub** — iOS-XCTEST(전체 Xcode 부재)·LIVE-ACCEPTANCE(오너 인프라)·Run 3개 종결 처리.
   위 "JM-AI Action Hub Run 3개 상태" 절 참조.
5. **IAG pilot** — 채널 실효, 상태 변화 없음. 오너 재지시 대기.
6. **sangfor-os 실운영 컷오버** — 원격 nonce authority·AC-DOD-09·운영 인프라 외부 게이트 3개는 07-29
   판단 그대로 유효. 그 사이 리포가 #165 까지 이동했지만 게이트 성격은 불변. 컷오버 재개 시점에
   U076 기준 SHA 재바인딩이 필요하다는 점만 추가된다.
7. **이 리포 미추적 잔여 처리(결정 완료).** `.gjc/`·`.serena/`·`.DS_Store` 는 런타임·도구 잔여라
   `.gitignore` 추가. `PROJECT_INVENTORY.md`(2026-07-31 인덱스)는 실체 문서라 커밋.

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

**현재 미해결 (2026-07-28 22:50 실측 갱신)** — **대체됨: 위 "현재 미해결 — 2026-08-06" 절이 정본. 아래는 원문 보존.**

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

## HIGH-1 실환경 종결 검증 — 2026-07-29 (Master 직접 실측)

리허설 스택이 기동된 상태에서 Master 가 `docker exec` 로 직접 확인했다. **이틀 전 HIGH-1 로 올린
"RLS 그린 증거가 프로덕션 접속 주체를 대표하지 않는다(false-green)" 가 실환경에서 종결됐다.**

- 활성 연결 주체: `sangfor_runtime_login` **3 conns**(API·Web 런타임), `sangfor_app_login` 1(스코프 바운드),
  `sangfor` 1(= Master 의 psql 세션 본인). **런타임이 소유자 롤로 붙지 않는다.**
- 롤 속성: `sangfor_runtime_login` super=false **bypassrls=false** inherit=true /
  `sangfor_app`·`sangfor_app_login` bypassrls=false noinherit / `sangfor`(소유자) super=true bypassrls=true.
- DDL 거부 실측: `SET ROLE sangfor_runtime_login; CREATE TABLE ...` → `ERROR: permission denied for schema public`.
- TRUNCATE 거부 실측: `TRUNCATE audit_logs` → `ERROR: permission denied for table audit_logs`.
  **감사로그 보호가 롤 수준에서 실제로 작동한다** — HIGH-1 에서 무력하다고 지적했던 바로 그 통제다.

리허설 Layer 1 통과 증거(워커 보고, Master 가 컨테이너 상태로 교차 확인): 스택 5개 컨테이너 healthy,
Caddy 내부 CA 경유 HTTPS `LOGIN_HTTP=200 CURL_EXIT=0`, authMode=jwt, 3-segment JWT, 인증 홈 200,
DB 세션 행 생성(tenant/company/project = rehearsal-*), 쿠키 mode 0600. DB 는 `sangfor_rehearsal` 로 분리됐다.

리허설 중 발견된 실제 결함 1건: **키링 시각(timestamp) 정규화가 필요했다** — 정규화 전 API·Web 이 healthy 로
올라오지 않았다. 실제 컷오버에서 동일하게 재현될 항목이므로 최종 리포트에 남길 것을 워커에 요구한다.

## 실운영 전환 — 오너 결정 (2026-07-29)

오너 지시 "오늘 sangfor-os 실운영이 가능하도록 처리". Master 조사 결과 **하드 게이트 3개가 전부 코드 밖 외부 의존성**이었다.

| 차단 요소 | 실측 근거 |
|---|---|
| 원격 HTTPS nonce authority 부재 | 리포 전체에 소비 코드만 존재(`verify-production-readiness.mjs`, `lib/production-authority.mjs`, 그 테스트). **서비스 구현 없음** |
| AC-DOD-09 외부 승인 미실행 | `connector-external-smoke-protocol.md` 가 "**future** credentialed external smoke verification" 스텁. 외부 승인자의 Ed25519 키 + 스테이징 자격증명 + 명시적 인간 승인 필요 |
| 운영 인프라 미정 | 호스트·도메인·DNS·시드된 운영 계층이 어떤 문서에도 없음. `DEFAULT_TENANT_ID/COMPANY_ID/PROJECT_ID` 가 가리킬 실체 부재 |

**오너 결정 2건.**
1. 경로: **오늘은 리허설까지, 실제 컷오버는 인프라 준비 후.** 통제 완화 우회는 선택하지 않았다.
2. 운영 호스트: **이 맥북에서 로컬로 운영.** 별도 서버·공인 도메인 없음 → ACME 불가, Caddy 내부 CA 경로.

**걸어 둔 작업(순차 — 동시 실행 시 포트·컨테이너·디스크 충돌).**
- `task_b189994e77af` / `ctx_3cb502d0add2` **진행 중** — main 이 `7be58a16` 로 이동해 기존 `a3554aec` 기준
  acceptance 가 후보에 바인딩되지 않는다. 새 SHA 권위 U076 재실행. 어느 경로를 택하든 필요한 무조건 작업.
- `task_6bc86df1e3c4` **대기** — 이 호스트 운영 배포 경로 전체 리허설. U076 완료 후 디스패치.

**리허설의 성격.** 목적은 통과가 아니라 **결함 노출**이다. 외부 승인 게이트는 설계상 로컬에서 충족 불가다 —
PR #153 이 사설·루프백 nonce authority 를 막았기 때문이다. 리허설은 그 지점까지 도달해 실패를 증거로 남기고
끝난다. **그 실패를 없애려 게이트를 완화하는 것은 금지**로 명시했다. sudo 도 워커가 실행하지 않고
오너가 붙여 넣을 명령 목록으로 넘긴다.

## P7 / production verifier 하드닝 — PR #153 (2026-07-29)

사후 리뷰 MED-1/MED-2 를 닫는 작업. **커밋 전 · PR 후 · 병합 전 세 지점 모두 Master 판정을 거쳤다** —
지난 라운드(CI 그린 + 자체 리뷰로 병합까지 진행)와 대비되는 정상 경로다.

- 커밋 전 판정 `msg_fa4a004ebcbc` APPROVE — 워크트리 실제 diff 를 읽고 판정. 4파일 정확히 허용 범위.
- PR 후 판정 `msg_0cdadc728f57` 내용 APPROVE + 병합 보류 — diff stat 이 승인본과 일치(+110/−1), 끼어든 커밋 없음.
- 병합 허가 `msg_d8dc8cc05b73` — 오너 승인 후. 체크 6/6 SUCCESS, `mergeable=MERGEABLE`, head 가 승인 커밋 `7adf4bb2` 그대로임을 확인.

**수정 내용.** `isDeniedNonceHost` 가 대괄호를 벗겨 주소를 분류한다 — IPv4 `0/8`·`10/8`·`127/8`·`169.254/16`·
`172.16/12`·`192.168/16`, IPv6 `::`/`::1`·`fe80::/10`·`fc00::/7`·`::ffff:0:0/96` 로 매핑된 위 IPv4,
호스트명 `localhost`·후행점·`*.localhost`. `validateComposeModel` 에 api/web
`SANGFOR_PROCESS_PROFILE === "production"` 검사 추가.

**Master 가 직접 확인한 회귀 위험(워커 미보고).** `docker-compose.production.yml:5` 의 `x-runtime-environment` 가
해당 값을 설정하고 api(180)·web(205)이 앵커를 상속한다 → 새 검사가 실제 배포 검증을 깨지 않는다.

**비차단 잔여(이번 PR 범위 밖으로 유지).** `::127.0.0.1`(→`[::7f00:1]`, RFC 4291 폐기 형식이라 실제 도달성 없음) /
`64:ff9b::/96` NAT64 프리픽스 / `100.64.0.0/10` CGNAT·`198.18.0.0/15` / 루프백으로 해석되는 공개 DNS 이름.

## P6 사후 적대적 리뷰 — 2026-07-29 08:00 (병합본 `a3554aec`, 범위 `24e31420..a3554aec` 49 files +1743/−154)

오너 지시로 병합 후 리뷰 수행. Master 메인 루프에서 직접, 편집 없이 읽기만. **CRITICAL/HIGH 0.**
컷오버가 `exit 64` 로 차단돼 있는 한 긴급 조치 없음. 다만 1·2번은 컷오버 전에 고치는 것이 맞다.

**내가 REJECT 했던 항목은 전부 해소됐고, 두 건은 요구를 넘어섰다.**
- MED-2 해소 — `validateComposeModel` 이 이제 compose 모델에서 직접 검사한다:
  `backend.internal===true`, api/web `DATABASE_URL` 의 `sangfor_runtime_login`, `app.tenant_id` RLS 스코프 핀,
  런타임 bind mount 금지, role-init 의 `NOBYPASSRLS`, `AUTH_BYPASS_ENABLED==="0"`,
  `API_KEY_BYPASS_ENABLED==="0"`, `AUTH_PROFILE!=="local_mock"`.
- MED-4 해소, **방향이 뒤집혔다** — `verify-production-deploy.mjs:45` 가 `AUTH_DEMO_PASSWORD` 를
  production 에서 **금지**한다. production 프로필은 per-user scrypt credential 을 쓴다. 내 원 지적보다 나은 결과.
- 회전 경쟁: `createPersistedSession` 이 트랜잭션 안에서 `SELECT credential_version ... FOR UPDATE` 로 확인.
- 실패 카운터: 원자적 raw `UPDATE` + `LEAST` 캡 + 5회째 잠금. 동시성 안전.
- receipt: Ed25519 detached, 도메인 분리 프리픽스, canonical JSON 키 정렬, 서명 64바이트 검사,
  base64url 정규식, compose/source archive SHA-256 바인딩, `basename(x)===x` 로 traversal 차단, 0600 기록.
- **nonce 소비 전에 서명키 쌍 preflight** — 순서가 맞다.
- 멤버십: `projectMember` + `userCompanyRole` 둘 다 active / `revokedAt` null / `validFrom`·`expiresAt` 창 검사.

**새로 발견한 것**

| 등급 | 항목 |
|---|---|
| MED-1 | **nonce authority 의 "원격" 보장이 작동하지 않는다 — `node` 로 실측 확인.** `production-authority.mjs` 가 `["localhost","127.0.0.1","::1"].includes(hostname)` 로 검사하는데 **`"::1"` 항목은 죽은 코드**다. `new URL("https://[::1]/").hostname` 이 대괄호를 포함한 `"[::1]"` 을 반환해 이 비교는 영원히 false — 막으려던 IPv6 루프백이 그대로 통과한다. 통과 확인: `[::1]`, `[::ffff:127.0.0.1]`(→`[::ffff:7f00:1]`), `0.0.0.0`, `127.0.0.2`(127/8 의 .1 이외 전부), `localhost.`, `a.localhost`, `169.254.169.254`, `10.0.0.5`, `192.168.1.1`. **정정**: `127.1`·`2130706433`·`0x7f.1` 은 WHATWG URL 이 `127.0.0.1` 로 정규화해 이미 차단된다(최초 기재 오류). 이 URL 은 외부 승인 nonce 재사용을 막는 **유일한 독립 권위**라 로컬을 가리키면 자기 승인이 성립. 파일이 root 소유 0600 이라 공격보다 **오설정 방어** 영역 |
| MED-2 | **compose 검증기가 `SANGFOR_PROCESS_PROFILE` 을 확인하지 않는다.** `login/route.ts` 는 `resolveProcessProfile()==="production"` 으로 인증 모드를 가른다. 이 값이 빠지면 데모 분기로 떨어지고, `AUTH_DEMO_PASSWORD` 가 금지라 결과는 **503 전면 로그인 불능**. 보안 우회는 아니지만(fail-closed), 12개 넘는 항목을 검사하면서 인증 모드를 결정하는 단 하나의 변수를 안 본다 — 전면 장애가 배포 검증을 통과한다 |
| LOW-MED | **사용자 열거 타이밍이 남아 있다.** scrypt 비용은 `DUMMY_DIGEST` 로 균질화됐지만 **DB 쓰기는 아니다.** 미존재 사용자 → `UPDATE` 없음 / 존재+오답 → `UPDATE` 1회 / 잠긴 계정 → `UPDATE` 없음. 응답 시간으로 세 상태가 구분된다. 워커의 "unknown-user timing 균질화" 주장은 scrypt 구간 한정이다 |
| LOW | `loadProductionAuthority` 의 approvalKeys 가드가 **빈 객체를 통과시킨다** — `Object.values({}).every(...)` 는 true. 하위에서 키 조회 실패로 fail-closed 되지만 "approval keys missing" 가드는 제 역할을 못한다 |
| LOW | `assertOwnerOnly` 에 `lstat`→`stat`→`read` TOCTOU 창. root 권한이 필요한 경로라 실질 위험 낮음 |
| 확인 필요 | **로그인이 기본 프로젝트 단일 스코프에 묶인다.** `resolveDefaultProjectScope()` 의 projectId 로만 멤버십을 확인하므로, 그 프로젝트 멤버가 아닌 유효 사용자는 로그인 자체가 불가능하다. 멀티 프로젝트 운영 의도면 제약, v1 단일 배포 전제면 정상 — **오너 확인 사항** |

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

## 채널 맵 — 2026-08-06 (정본)

2026-08-06 터미널 위생 분류(35개) 기준으로 다시 그리고, 08-07 00:5x 재실측(37개)까지 반영했다. 옛 07-28 맵의
핸들·task·dispatch 좌표는 전부 실효라 아래 절에 원문만 보존한다. "활성 에이전트"는 preview 에서 실행
중이 확인된 핸들이다. **포함 규칙: 라이브 터미널이 있거나, 터미널이 없어도 미해결 작업이 남은 체크아웃.**
close 로 0이 된 뒤 잔여 작업도 없는 체크아웃(jarvis-ai 3개, JM-AI Auto Work OS 1개 close)은 등재하지 않는다.

| 채널 | 프로젝트 / 체크아웃 | 터미널 | 활성 에이전트 | 상태 |
|---|---|---|---|---|
| C1 | sangfor-engineer-mcp<br>`Playground/whelp99-code-sangfor-engineer-mcp` | 4 | `term_deef777e` (GJC) | 활성. 오늘 PR #11 머지, `feat/plan-closeout`=origin/main, dirty 5 |
| C2 | ProofGraph-Graph-Native-v7.0.0<br>`Playground/ProofGraph-Graph-Native-v7.0.0` | 4 | `term_f0228f8d` (GJC) | 활성. PiDelegatedAdapter per-call 옵션 작업 |
| C3 | JM-AI Master Worker<br>`Playground/JM AI-OS Pack/JM-AI Master Worker` | 14 | `term_3c8996d3` (GJC) | 활성. 최대 스트림. 고아 4개(스크롤백 보유) 폐기 판단 대기 |
| C4 | JM-AI Action Hub<br>`Playground/JM AI-OS Pack/JM-AI Action Hub` | 0 (빈 셸 4개 close) | — | Run 3개 조사 완료. iOS-XCTEST·LIVE-ACCEPTANCE 오너 결정 대기 |
| C5 | sangfor-os daggertooth<br>`orca/workspaces/sangfor-os/daggertooth` | 2 | `term_3cb5cd37` (GJC) | 활성. tip `a95cc66` = #194 Codex Spark |
| C6 | Playground/sangfor-os | 2 | — | 유휴. `feat/codex-spark-llm` 미푸시 10커밋 |
| C7 | wiki-spike<br>`orca/Wiki-spike/wiki-spike` | 2 | `term_7ea47317` (GJC) | 활성. `docs-root-cleanup` 미푸시 2커밋 |
| C8 | ITAC-security-essentials<br>`Projects/ITAC-security-essentials` | 4 | `term_e24ff067` | 활성. WinRM·로그 전송 보안 검토 |
| C9 | EvoHarvest<br>`Playground/JM AI-OS Pack/EvoHarvest` | 2 | — | 유휴. 통신 테스트 이력만 |
| C10 | Orca-JARVIS (관제탑) | 1 | `term_8ea40ebd` | 이 세션 |
| C11 | wiki-spike qwen-works<br>`orca/workspaces/wiki-spike/qwen-works` | 2 | — | 유휴. 위생 분류(23:51) 이후 관측된 워크트리 채널. 실행 중 에이전트 없음, 스크롤백 14·29행(종료된 셸 잔여) |
| — | sangfor-os main-fork<br>`orca/workspaces/sangfor-os/main-fork` | 0 | — | 터미널 없음. origin/main 대비 28 behind, dirty 58 — 동기화 판단 대기 |
| — | wiki-spike-collector<br>`orca/Wiki-spike/wiki-spike-collector` | 0 | — | 터미널 없음. dirty 12, tip `c2be765`(08-01) |

터미널 합계 4+4+14+0+2+2+2+4+2+1+2 = **37** (23:51 위생 분류 시점 35 + 이후 신규 qwen-works 2).
위생 분류 절의 35는 그 시점 스냅샷이고, 이 맵은 08-07 00:5x 재실측 기준이다 — 라이브 환경이라 수치는 계속 움직인다.

## 채널 맵 (2026-07-28) — **실효: 핸들·task·dispatch 좌표 전부 무효. 위 "채널 맵 — 2026-08-06" 이 정본. 아래는 원문 보존.**

| 채널 | 프로젝트 / 체크아웃 | 메인 에이전트 | task / dispatch | 담당 |
|---|---|---|---|---|
| P1 | sangfor-engineer-mcp<br>`Playground/whelp99-code-sangfor-engineer-mcp` | `term_92dea65a` (grok) | `task_4a7fd29b5001` / `ctx_63c3af94cb6c` | **완료** — 아래 참조 |
| P2 | sangfor-os-w0-w6<br>`Playground/sangfor-os-w0-w6` | `term_d4bb2736` (gpt-5.6-sol) | dispatch 없음 (status 통보만) | 종결 (`msg_e8f5b4029023`) — main `a3554aec` 병합, **Master 게이트 미통과분 존재** |
| P7 | sangfor-os main 검증 하드닝 | `term_d4bb2736` (gpt-5.6-sol) | `task_d2982ce6b91b` / `ctx_f77e4275378f` | **완료·종결** — PR #153 병합(`7be58a16`), `7adf4bb2` 가 origin/main 조상 확인. 체크 6/6 SUCCESS |
| P8 | sangfor-os 실운영 전환 | `term_a8102741` (gpt-5.6-sol, 구 `term_d4bb2736`) | `task_b189994e77af` / `ctx_3cb502d0add2`, `task_6bc86df1e3c4`(대기) | **진행 중** — U076 권위 재실행 → 로컬 리허설. 컷오버는 외부 게이트 대기 |
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
