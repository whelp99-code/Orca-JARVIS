# Workboard regression and production-isolation check (2026-09-24)

Worktree: `/home/jm/orca/workspaces/Orca-JARVIS/purpose-workboard`; HEAD before checks: `cd24973` (ancestor check exit 0). Initial `git status --short --branch` showed a clean `whelp99-code/purpose-workboard` branch. All commands below ran in that worktree unless an absolute path is shown. No production apply, deploy, activation, push, restart, or authority-link edit was performed.

| Executed command | Exit | Result |
| --- | ---: | --- |
| `git merge-base --is-ancestor cd24973 HEAD` | 0 | Expected commit present at HEAD. |
| `readlink /home/jm/.local/state/orca-jarvis/authority/current` (before tests) | 0 | `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c` |
| `ss -ltnpe '( sport = :4173 or sport = :4174 or sport = :4176 or sport = :4180 )'` (before tests) | 0 | Listener identities below. |
| `node scripts/run-tests.mjs backend tests/integration/workboard-ingest.test.ts tests/integration/workboard-actions.test.ts tests/integration/workboard-action-routes.test.ts tests/unit/workboard-purpose.test.ts tests/unit/workboard-attention.test.ts` | 0 | 5 files, 47 tests passed. |
| `node scripts/run-tests.mjs dashboard src/workboard/page.test.tsx src/workboard/action-slot.test.tsx` | 0 | 2 files, 10 tests passed. No unrelated dashboard health tests were run or classified as workboard results. |
| `readlink /home/jm/.local/state/orca-jarvis/authority/current` (after tests) | 0 | Same target: `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c`. |
| `ss -ltnpe '( sport = :4173 or sport = :4174 or sport = :4176 or sport = :4180 )'` (after tests) | 0 | Same listener identities; no 4180 listener at either snapshot. |

Before and after `ss` snapshots (all on `127.0.0.1`):

| Port | Before / after identity | Attribution |
| --- | --- | --- |
| 4173 | uid 994, socket inode 915858332, cgroup `jm-jarvis-dashboard.service` | Unchanged; process name/PID not visible to this user. |
| 4174 | uid 1000, socket inode 900663198, `node` pid 203880, cgroup `core5-review-ui.service` | Unchanged. |
| 4176 | uid 1000, socket inode 686110942, `MainThread` pid 3462770, cgroup `jm-jarvis-phone-gateway.service` | Unchanged. |

These checks show no authority-link change or listener rebind over the measured interval, and the targeted workboard tests passed. They do not assert that the entire production runtime or DB is identical, nor that unrelated test suites passed. No listening process was stopped.
