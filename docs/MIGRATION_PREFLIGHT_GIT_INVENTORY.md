# 서버 이전 전 Git 정리 인벤토리

> **MUST 처리 상태 (2026-08-10 실행):** 1–10 항목 커밋/푸시/미러 완료. 상세는 CONTROL_TOWER.md.


- **실측 시각:** 2026-08-10 (KST)
- **스캔 범위:** DevSpace 주요 루트 96개 git checkout (Playground / orca / Documents_Playground / Orca-JARVIS / Projects / dify / me-wiki / blro-preview 등)
- **액션 대상:** 52개 (dirty / unpushed / local-only / unmerged / core)
- **원본 표:** [migration-git-audit-20260810.tsv](./migration-git-audit-20260810.tsv)

범례

| 기호 | 의미 |
|------|------|
| **C** | 미커밋 (dirty working tree) |
| **P** | 미푸시 (로컬 tip이 remote보다 ahead, 또는 remote 브랜치 없음) |
| **M** | main/origin/main 미머지 (브랜치 tip에 main에 없는 커밋) |
| **B** | 브랜치/워크트리 정리 후보 (gone remote, recovery, stale worktree) |
| **R** | remote 없음 (이전 시 원격 미러 필수) |

---

## 0. 이전 직전 우선순위 (MUST)

서버로 옮기기 전에 **유실되면 복구 비용이 큰 것**만 먼저.

| # | 저장소 | 상태 | 해야 할 일 |
|---|--------|------|------------|
| 1 | `Playground/whelp99-code-sangfor-engineer-mcp` | **P M** (+ 바이너리 dirty 1) | `feat/plan-closeout` **4 commits** 푸시+PR. PPTX 원복 또는 커밋 결정. 머지된 옛 브랜치 삭제 후보 다수 |
| 2 | `orca/Wiki-spike/wiki-spike` | **P M B** | `docs-root-cleanup` **origin 대비 ahead 1** 푸시. main 대비 5 commits — 병합 여부 결정. 워크트리 4개+ collector dirty 12 |
| 3 | `Playground/JM AI-OS Pack/EvoHarvest` | **C P M** | dirty 4 + `hardening/...` **ahead 1** 푸시/커밋. main 미머지 |
| 4 | `Playground/JM AI-OS Pack/JM-AI Master Worker` | **C** | dirty 3 (evoharvest 연동 + PROJECT_STATUS.html) 커밋/폐기 |
| 5 | `Playground/sangfor-os` | **P M B** | main은 clean·동기. 로컬 **gone/unmerged 브랜치 ~15** + worktree 5 — 보존 푸시 vs 삭제 판정 |
| 6 | `Orca-JARVIS` | **R** | remote 없음. 서버/GitHub에 **origin 생성 후 전체 푸시** 필수 (장부 유실 방지) |
| 7 | `Playground/BLRO-Website-source-20260801` | **C** | dirty 18 (콘텐츠 mdx + 신규 글) 커밋/푸시 |
| 8 | `orca/loop-engineering-labs` | **C** | dirty 11 (skills/workshop) 커밋 여부 |
| 9 | `blro-homepage-sites-preview` | **C** | dirty 15 + `site-preview.tar.gz` — 커밋 제외/포함 정책 |
| 10 | remote 없는 로컬 전용 레포들 | **R** | 아래 §4 — 백업 미러 없으면 이전 시 유실 |

---

## 1. 미커밋 (Commit 안 된 작업)

### 1-A. 핵심 / 활성 프로젝트

| 경로 | 브랜치 | dirty | 요약 |
|------|--------|------:|------|
| `Playground/whelp99-code-sangfor-engineer-mcp` | `feat/plan-closeout` | 1 | `outputs/...MCP.pptx` 바이너리 변경 (의도 불명 → 원복 권장) |
| `Playground/JM AI-OS Pack/JM-AI Master Worker` | `main` | 3 | `evoharvest.ts`, test, `PROJECT_STATUS.html` |
| `Playground/JM AI-OS Pack/EvoHarvest` | `hardening/local-complete-20260804` | 4 | release packaging 스크립트/테스트/manifest |
| `orca/Wiki-spike/wiki-spike-collector` | `second-brain-operational-authority-adapter` | 12 | second-brain docs/scripts/tests 수정 (wiki-spike 동일 git) |
| `orca/loop-engineering-labs` | `main` | 11 | skills/install/workshop + untracked tests/converge-loop |
| `Playground/BLRO-Website-source-20260801` | `main` | 18 | insights mdx 14수정 + 신규 2 + research notes |
| `blro-homepage-sites-preview` | `main` | 15 | pages/css + tar.gz + 삭제 파일 |
| `dify` | `main` | 6 | 루트/하위 `AGENTS.md`만 (로컬 주입 가능성 높음 → 커밋 비권장) |
| `Playground/ProofGraph-Graph-Native-v7.0.0` | `main` | 1 | `.DS_Store` only |
| `me-wiki` | `master` | 1 | `.DS_Store` only |

### 1-B. 대량 dirty / 특수 상태 (주의)

| 경로 | dirty | 비고 |
|------|------:|------|
| `Playground/AI-Engine` | 576 | **커밋 히스토리 깨짐/미정착** (`No commits yet on main...origin/main [gone]`). 이전 전 별도 복구 판정 |
| `Documents_Playground` (+ nested) | 540× | 메타/중첩 checkout 오염 가능 — 통째 커밋 금지, 내용 선별 |
| `Documents_Playground/sangfor-mcp-workflow` | 46 | `cursor/operator-console-mcp-integration` |
| `orca/workspaces/sangfor-os/main-fork` | 58 | recovery worktree (레거시) |
| `orca/workspaces/whelp99-code-sangfor-engineer-mcp/ratfish` | 60 | worktree dirty |
| `Playground/BLRO-Website-recovery-20260731` | 94 | archive 성격 |
| `orca/projects/AI-CRM+Project Manager` | 22 | |
| `orca/projects/*` 일부 | 2–4 | AI_Supporter, 개발앱 관리툴 등 |

### 1-C. Orca worktree dirty (공유 git 오브젝트)

| 워크트리 | dirty | 비고 |
|----------|------:|------|
| `orca/workspaces/wiki-spike/qwen-works` | 10 | |
| `orca/workspaces/Toss-finance/*` | 1–3 | grouper / tradingcodex / wizard-execution |
| `orca/workspaces/sangfor-os/u076-main-8d83d2b9` | 14 | recovery |

### 1-D. Fork/아카이브 dirty (우선순위 낮음)

`Playground/001. Fork Repo/*` 다수 (Agent-Reach, skillopt, trellis 등) — 서버 이전 시 **아카이브 묶음 백업**이면 충분, 개별 커밋 불필요 가능.

---

## 2. 미푸시 (Push 안 된 커밋 / remote 브랜치 없음)

### 2-A. 즉시 푸시 후보

| 저장소 | 브랜치 | ahead | 비고 |
|--------|--------|------:|------|
| **engineer-mcp** | `feat/plan-closeout` | **4** | captcha handshake 포함. origin에 브랜치 없음 |
| **wiki-spike** | `docs-root-cleanup` | **1** | origin 대비 ahead (전체 main 대비 5) |
| **EvoHarvest** | `hardening/local-complete-20260804` | **1** | dirty 4와 함께 정리 |
| **orca/projects/controller** | `main` | **2** | |
| **wiki-spike** | `whelp99-code/trevally` | 5 | worktree tip, origin 브랜치 없음 |
| **wiki-spike** | `ooo/orch_e268807fc129` | 4 | ouroboros worktree |
| **sangfor-os** | `whelp99-code/daggertooth` | 11 | remote tracking **gone** — 재푸시 or 폐기 |
| **sangfor-os** | 다수 `fix/*`, `feat/mfa-totp` 등 | 1–7 | tracking **[gone]** — 보존 필요 시 재푸시 |

### 2-B. main은 동기, 로컬 브랜치만 미푸시/고아

| 저장소 | main 상태 | 로컬 이슈 |
|--------|-----------|-----------|
| **sangfor-os** | `72fe1f1` = origin/main, clean | gone/unmerged 로컬 브랜치 다수 + worktree |
| **Action Hub** | `5e435a0` = origin/main, clean | `whelp99-code/weever` local-only; `fix/real-device-qa-20260809`는 origin 있으나 main 대비 1 |
| **Auto Work OS** | hardening 브랜치 origin 동기 | main 미머지 상태 유지(의도적일 수 있음) |

### 2-C. Remote 자체가 없음 (푸시 대상 생성 필요)

| 경로 | HEAD | dirty |
|------|------|------:|
| **Orca-JARVIS** | `main` @ `4baca43` | 0 |
| **ProofGraph-Graph-Native-v7.0.0** | `main` @ `5ebfebb` | 1 (.DS_Store) |
| **me-wiki** | `master` @ `7c8b927` | 1 |
| **orca/projects/AI_Supporter** | `master` | 4 |
| **orca/projects/DEV** | `master` | 0 |
| **orca/projects/개발앱 관리툴** | `master` | 2 |

---

## 3. 미머지 (main에 안 들어간 브랜치)

### 3-A. sangfor-os (canonical: `Playground/sangfor-os`)

main `72fe1f1` clean. **origin/main에 없는 로컬 브랜치 tip:**

| 브랜치 | origin/main 대비 commits | remote |
|--------|-------------------------:|--------|
| `feat/codex-spark-llm` | 14 | origin 있음 |
| `whelp99-code/daggertooth` | 11 | **gone** |
| `fix/web-mail-candidates-ai-first` | 7 | 로컬 only |
| `feat/mfa-totp` | 3 | **gone** |
| `fix/disappointment-non-mcp` | 3 | **gone** |
| `fix/finance-chatbot-base-url-deploy` | 3 | 로컬 |
| `fix/finance-chatbot-base-url` | 2 | 로컬 |
| 기타 `fix/*` 다수 | 1 each | 대부분 **gone** |

**main에 이미 흡수된 것으로 보이는 삭제 후보:**  
`codex/loop-graph-pr001`, `local-recovery/main-fork`, `local-recovery/u076-main-8d83d2b9` (tip이 main 조상)

**워크트리 (정리 대상):**

- `.../daggertooth` → daggertooth 브랜치
- `~/orca/.../main-fork`, `u076-main-8d83d2b9` → recovery (구 커밋 `20dbc00`)
- `worktrees/sangfor-os-loop-graph-pr001`
- `~/.local/share/sangfor-u076-.../attempt/source` (detached)

### 3-B. sangfor-engineer-mcp

| 브랜치 | 상태 |
|--------|------|
| **`feat/plan-closeout`** | main 대비 **+4**, **미푸시** — **머지 후보 #1** |
| `feat/agent-ready-w1-w5` 등 옛 feature | main에 흡수된 것으로 보임 → 삭제 후보 |
| `ooo/orch_*`, `whelp99-code/ratfish` | main tip과 동일 → worktree 제거 후 브랜치 삭제 가능 |

### 3-C. wiki-spike

| 브랜치 | origin/main 대비 | 비고 |
|--------|----------------:|------|
| `db03-migration-source-evidence` | 19 | origin 있음 |
| **`docs-root-cleanup`** | **5** (origin 대비 +1 미푸시) | 활성 작업 브랜치 |
| `second-brain-operational-authority-adapter` | 5 | collector worktree, **dirty 12** |
| `whelp99-code/trevally` | 5 | local-only |
| `ooo/orch_e268807fc129` | 4 | local-only |
| `gate8-completion` | 1 | origin 있음 |
| `second-brain-local-boot-decision-records` | 1 | origin 있음 |
| `whelp99-code/qwen-works` | (merged-ish) | 삭제 후보 가능 |

### 3-D. JM-AI Action Hub

| 브랜치 | 상태 |
|--------|------|
| `main` | origin 동기, clean — **완료** |
| `fix/real-device-qa-20260809` | origin 있음, main 대비 +1 (PR #8 이전 tip 계열일 수 있음) |
| `whelp99-code/weever` | local-only, 구 tip |

### 3-E. EvoHarvest / Auto Work OS / Master Worker

| 저장소 | 브랜치 | 이슈 |
|--------|--------|------|
| EvoHarvest | `hardening/local-complete-20260804` | main 미머지 + ahead 1 + dirty 4 |
| Auto Work OS | `hardening/local-complete-20260804` | origin 동기, main 미머지 (정책 확인) |
| Master Worker | `main` 동기 | dirty 3만 처리하면 됨. hardening 브랜치는 origin 있음 |

### 3-F. jarvis-ai plan worktree (대량 로컬 브랜치)

`orca/workspaces/jarvis-ai/plan` — `feat/pr-206-wakeword` 등 **로컬 브랜치 20+**, 다수 merged_safe_delete 표기. 이전 전 **보존 브랜치 백업 vs 대청소** 결정 필요.

---

## 4. Remote 없는 저장소 (서버 이전 시 백업 필수)

이전 대상 서버/Git에 **mirror push** 하지 않으면 히스토리 유실.

1. `Orca-JARVIS` — 관제 장부 (최신 `4baca43`)
2. `Playground/ProofGraph-Graph-Native-v7.0.0`
3. `me-wiki`
4. `orca/projects/AI_Supporter`
5. `orca/projects/DEV`
6. `orca/projects/개발앱 관리툴`
7. (상태 특이) `Playground/BLRO-Website`, `AIOSv2_integration` — remote 없음/비정상 checkout 가능

---

## 5. 브랜치·워크트리 정리 후보 (정리해도 될 가능성 높은 것)

> 삭제 전 `git branch --merged main` / tip SHA 재확인. 여기 목록은 후보.

### 삭제 후보 (merged / tip = main 조상)

**engineer-mcp:**  
`feat/agent-ready-w1-w5`, `feat/customer-ready-mcp-scorecard`, `feat/field-project-tooling`, `feat/officecli-documents`, `fix/mcp-env-at-startup`, `ooo/orch_a451806b44f5`, `whelp99-code/ratfish` (worktree 제거 후)

**sangfor-os:**  
`codex/loop-graph-pr001`, `local-recovery/*` (worktree 제거 후), 이미 main에 머지된 gone fix 중 tip이 main에 포함된 것

**Action Hub:**  
`whelp99-code/weever` worktree + 브랜치 (main에 반영된 옛 작업이면)

### Worktree 제거 후보

| 경로 | 이유 |
|------|------|
| sangfor-os main-fork / u076 recovery | 구 커밋, dirty 잔여 |
| engineer-mcp ratfish / ooo orch | main tip 복제 |
| Action Hub weever / real-device-qa | main 완료 후 잔여 |
| wiki-spike qwen-works / ooo orch | 완료/중복 가능 |
| jarvis-ai plan 다수 feat/* | 장기 방치 로컬 |

### 보존 후 푸시해야 할 가능성

- engineer-mcp `feat/plan-closeout`
- wiki-spike `docs-root-cleanup` (+ collector dirty 정리 후 adapter 브랜치)
- sangfor-os `feat/codex-spark-llm`, daggertooth, 일부 finance/mail fix (gone이면 재푸시)
- EvoHarvest hardening tip

---

## 6. 권장 처리 순서 (서버 이전 런북)

```
Phase A — 유실 방지 백업
  1) remote 없는 6+ 레포 → bare mirror 또는 GitHub private 생성 후 push --all --tags
  2) DevSpace 전체 rsync/스냅샷 (git 외 런타임 데이터 포함)

Phase B — 미커밋 정리 (핵심만)
  3) engineer-mcp: PPTX 원복 → plan-closeout 푸시 → PR
  4) EvoHarvest: dirty 커밋 + push
  5) Master Worker: dirty 커밋 또는 폐기
  6) BLRO-Website-source: content 커밋/푸시
  7) wiki-spike-collector dirty: 커밋 or 폐기 후 docs-root-cleanup push
  8) loop-engineering-labs / blro-preview: 커밋 정책 결정

Phase C — 미머지 결정
  9) wiki-spike docs-root-cleanup → main PR?
 10) sangfor-os gone 브랜치: 재푸시 목록 vs 삭제 목록 확정
 11) EvoHarvest/Auto Work hardening → main 머지 여부

Phase D — 브랜치/워크트리 청소
 12) merged 브랜치 삭제, stale worktree remove
 13) 001. Fork / recovery / hollow 아카이브를 이전 제외 또는 cold storage

Phase E — 검증
 14) 핵심 레포 git status clean + origin 0/0
 15) 이 문서 체크박스 갱신 후 서버 clone 스모크
```

---

## 7. 지금 “이미 정리된” 것 (참고)

| 저장소 | 상태 |
|--------|------|
| JM-AI Action Hub `main` | origin 0/0, clean |
| sangfor-os `main` | origin 0/0, clean |
| Orca-JARVIS working tree | clean (단 remote 없음) |
| Auto Work OS hardening tip | origin 동기, clean |

---

## 8. 통계 (2026-08-10 스캔)

| 항목 | 수 |
|------|---:|
| 스캔된 git checkout | 96 |
| 액션 필요(필터 후) | 52 |
| dirty checkout | 36 |
| unpushed 신호 있는 checkout | 23 |
| local-only 브랜치 있는 checkout | 29 |
| unmerged-to-main 신호 | 23 |
| remote 없음 | 6+ |

> 같은 git 오브젝트를 공유하는 worktree는 브랜치 목록이 중복 집계된다. §3의 **primary checkout 기준 표**를 정본으로 쓴다.
)
