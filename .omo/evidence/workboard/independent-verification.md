# Independent workboard verification (2026-09-24)

Worktree HEAD `12d1a084ae802e755724e997e2599ee335d8f488`. No production DB was opened, copied, or migrated. No live approval was sent; the only sends targeted the disposable loopback fixture agent. Checkbox 8 was not started. No deployment, push, or production authority change.

## Source-to-projection comparison

Command (cwd `/home/jm/orca/workspaces/Orca-JARVIS/purpose-workboard`):

```sh
node .runtime-tmp/workboard/independent-verify.mjs
```

Exit **0**. Output: `COVERAGE_PASS` with 20 discovered/configured source IDs, one current-work projection and zero duplicate work IDs; `SCENARIO_PASS` with approve, reject, redirect and four source receipts. Script source is retained at `.runtime-tmp/workboard/independent-verify.mjs` (disposable, ignored). `coverage-final.json` contains the read-only source observations and exact collected/projected keys. The script verifies inventory vs configured source IDs; independently calls bounded `orca-ide` worktree/terminal list for Linux and Mac (checks success, truncation, and totalCount); then invokes the current-work collector on Linux current metadata into an **in-memory** SQLite projection and compares source+session identities to `readWorkboard`. CLI worktree and terminal rosters are metadata, not evidence of active work. Historical JSONL counts are not current-work totals. An unsuccessful CLI scan is recorded as inaccessible with a reason and null total, never as zero. Unknown current-work coverage has null total and an explicit reason. The sole confirmed current session matches the sole projected work. No path-based aliases or path-only merges are performed: work identity is source+session+task; duplicate `work_id` count is 0. Mac application/session sources and unregistered sources remain unknown or inaccessible rather than inferred empty. This verifies a disposable projection of fresh readable data, **not** a claim that production already contains all work.

The existing baseline source inventory is the 20-source discovery denominator; the independent work reads were performed fresh by the command above. No live app protocol is inferred from successful read-only metadata discovery.

## Disposable decision loop

The same executable script uses `startActionAgent`, an HTTP loopback structured endpoint, a fresh disposable journal and `WorkboardActions`. Each fixture progress state transitions to an explicit approval wait, then one approve, one reject, and a new request redirected after rejection. `real-work-scenario.json` records original request, durable intent, source receipt, one send and one source receipt read per decision; a second receipt re-read matches. A fourth request loses its ACK with receipts temporarily hidden. A journal close/reopen simulates restart, a changed request ID is blocked, the original intent remains uncertain without another send, and exposing the original receipt reconciles it. Fixture progress/wait states are explicitly synthetic; this is not a live agent workflow. The related real dashboard route tests exercise protected routes and duplicate clicks.

**Direct-handling acceptance remains incomplete.** Live Claude, Codex, Orca, OmO and Senpi have no verified structured approval protocol. A workboard screen or a direct-processing label does not complete that acceptance, and no terminal-key approval fallback or live approval was attempted.

## Commands and exit codes

All commands below ran with cwd `/home/jm/orca/workspaces/Orca-JARVIS/purpose-workboard`, except the symlink read, which uses an absolute path.

| Exact command | Exit | Observation |
| --- | ---: | --- |
| `node .runtime-tmp/workboard/independent-verify.mjs` | 1 (first attempt) | Test harness lacked `workboard_attention` table; added disposable migration 101 to harness only. No product defect. |
| `node .runtime-tmp/workboard/independent-verify.mjs` | 0 | `COVERAGE_PASS` and `SCENARIO_PASS`. |
| `JARVIS_SECOND_BRAIN_LAUNCHER="$PWD/.runtime-tmp/workboard/no-provider/sb-mcp" JARVIS_SECOND_BRAIN_CONFIG="$PWD/.runtime-tmp/workboard/no-provider/config.toml" JARVIS_SECOND_BRAIN_REFRESH_RECEIPT='' node scripts/run-tests.mjs backend tests/integration/workboard-current-work.test.ts tests/integration/workboard-ingest.test.ts tests/integration/workboard-actions.test.ts tests/integration/workboard-action-routes.test.ts` | 0 | 4 files, 38 tests passed; live Linux current-work read agrees with projection and no duplicates. |
| `node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync,readlinkSync} from "node:fs"; const c=JSON.parse(readFileSync(".omo/evidence/workboard/coverage-final.json")),s=JSON.parse(readFileSync(".omo/evidence/workboard/real-work-scenario.json")); assert.equal(c.source_count,20); assert.deepEqual(c.collected_keys,c.projected_keys); assert.equal(c.duplicate_work_id_count,0); assert(c.sources.every(x=>x.classification==="current_work"||x.reason)); assert.deepEqual(s.phases.map(x=>[x.outcome.receipt.operation,x.send_count,x.source_receipt_reads_at_settlement]),[["approve",1,1],["reject",1,1],["redirect",1,1]]); assert.equal(s.uncertain_restart.final_sends,1); assert.equal(readlinkSync("/home/jm/.local/state/orca-jarvis/authority/current"),"releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c"); console.log("EVIDENCE_ASSERTIONS_PASS")'` | 0 | Evidence shape, comparison, decisions, symlink verified. An earlier version of this assertion mistakenly used `s.sources` rather than `c.sources` and exited 1; corrected the assertion only. |
| `readlink /home/jm/.local/state/orca-jarvis/authority/current` | 0 | `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c`. |
| `git status --short` | 0 | Only three untracked deliverable files in this worktree; no tracked product changes. |

Before and after production readlink values in both JSON files match `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c`. The one disposable fixture directory and HTTP server were removed/closed. No commit was made.
