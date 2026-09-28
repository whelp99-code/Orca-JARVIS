# Task 32 remediation evidence: Memory search, conflict, correction, and privacy surface

Branch `task-32-remediation`, base `48287b6eb6122d746380278618871ea729b0e525`, code head `16c421a`.
Everything here was produced in this worktree against the isolated in-repo fixture
(`tests/fixtures/memory-surface-fixture.ts`) on ephemeral loopback ports. Production ports
4173-4176, `~/.local/state`, systemd units, the real vault, and the main checkout were not touched.

## Blockers from `.omo/evidence/task-32-acceptance-gate.md` and where each is proven

| id | fix | RED on HEAD 48287b6 | GREEN | browser proof |
|---|---|---|---|---|
| B1 60 s stale search | `dashboard/src/memory-store.ts` `ensureFreshStatus` + `Refresh memory` control | `memory-store-freshness.test.ts` 5/7 failed | 7/7 | `12-idle-65s-search-1440.png` (real 65 s idle, then `status` + `search` only) |
| B2 citation/history | `src/dashboard/memory-record-history.ts`, `memory-redaction.ts`, `memory-detail.tsx` | `task32-memory-history.test.ts` 4/5 failed; `memory-detail.test.tsx` 6/6 failed | 5/5, 6/6 | `01-detail-citation-1440.png`, `02-correction-staged-1440.png`, `03-superseded-1440.png` |
| B3 effects lifecycle | `dashboard/src/memory-api.ts` effects fan-out, `memory-effects.tsx` | `memory-api.test.ts`, `memory-surface-states.test.tsx` failed | green | `04-forget-staged-1440.png` (Forgetting / pending), `03-...` (Correction / applying) |
| B4 busy/error/capability | `memory-detail.tsx`, `memory-messages.ts`, `MemoryRequestError` | `memory-detail.test.tsx` (double click sent 2, no typed error) | green | stale-selection spec: 404 announced, 0 export commands, 0 page errors |
| B5 offline as empty | `memory-search.tsx`, `providerState` in `memory-page.tsx` | `memory-surface-states.test.tsx` failed | green | `08-offline-1440.png`, `08-unavailable-1440.png`, `09-offline@{1440,640,390}.png` |
| B6 CJK mid-syllable | `dashboard/src/styles/memory.css` (`word-break: keep-all; overflow-wrap: anywhere` on `.memory-page`) | layout spec computed-style assertion fails on HEAD | green | `10-cjk-390.png` |
| origin_label path | `safeOriginLabel` in `memory-redaction.ts` | `task32-memory-history.test.ts` last case failed | green | happy path asserts `/vault/` absent from DOM |
| e2e reproducibility | in-repo fixture + `playwright.task32.config.ts` + `npm run test:e2e:memory` | n/a | 11/11 | `playwright-run.log` |

## Layout

- `playwright/<spec>-<title>/*.png`: full-page screenshots named in scenario order (01-12) plus
  `memory-{1440,640,390}.png` from the privacy spec; every PNG was opened and inspected.
- `playwright/<spec>-<title>/trace.zip`: Playwright trace for every scenario (`trace: "on"`).
- `playwright-run.log`: the list reporter output of the final run (11 passed).
- `logs/`: lint, typecheck, architecture:check, build, backend memory integration (12 files / 45 tests),
  unit memory (3 files / 28 tests), full dashboard vitest (42 files / 285 tests, 0 React warnings).
- `manifest.json`: sha256 and size of every file in this directory.

## Reproduce

```bash
npm ci && npm run build && npm run test:e2e:memory
```
