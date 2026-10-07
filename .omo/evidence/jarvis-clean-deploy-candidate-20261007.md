# TASK-JARVIS-CLEAN-DEPLOY-CANDIDATE

Status: VERIFIED local frozen candidate; full backend passed on its only execution. Publication and remote CI are separately recorded in the draft PR.

Base origin/main and measured candidate code HEAD: 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f.
Branch: release/jarvis-clean-candidate-20261007.
Worktree: /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007.
Issue: https://github.com/whelp99-code/Orca-JARVIS/issues/64.
Node v24.19.0; npm11.17.0; ABI137; Linux x64.

## Executed checks

| Check | Exit | Elapsed seconds | Raw log SHA-256 |
| --- | ---: | ---: | --- |
| install | 1 | 0.582 | 2e5ad071930f76b2a9421c068c223a247700944df574e54eac7e9cc8f337d3c1 |
| install-direct | 0 | 2.967 | 8720299b52fd6a406e000a583a9474e42f8ab4d18c14a93bf8ac57f744763c80 |
| build | 0 | 15.007 | 5fea15c921cc552a976489eb1a0900566009d3d5f61984976609892b1ae7c230 |
| typecheck | 0 | 22.606 | 84d99ab28abcf6f57d71ce4ff8c68f66ce6153a105f2a09ac2f32a536ee90217 |
| lint | 0 | 11.250 | de112ca20d27a19a07de6f80e64001174903c7bfbeaf91857b464afb71df5846 |
| inventory-check | 1 | 10.609 | de56abb8564d532a31fec06ec5a6a6ca7e13432f1184a8c558fe92d396170376 |

Command transcripts/results remain in /home/jm/.omo/evidence/jarvis-clean-deploy-candidate-20261007, outside the candidate. Lockfile SHA-256 before/after frozen install: 0378edb0a0b3c2f8df1aab4d511d48df5c2101f3056586c2e6c61e20a9bdfc17.

The initial nested npm exec wrapper failed before dependency installation with EALLOWSCRIPTS: it passed npm_config_allow_scripts=omo-ai into project-scoped npm11. The direct cached npm11 CLI used package.json allowScripts and installed 430 packages with exit0. No package/lockfile or source changed; the failed wrapper attempt remains recorded and was not a backend execution.

## Exact commands

```bash
export PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:$PATH
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
unset npm_config_allow_scripts
# install: exit 1, 0.582s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
npm exec --yes --package=npm@11.17.0 -- npm ci --no-audit --no-fund
# install-direct: exit 0, 2.967s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/.npm/_npx/6416243750526179/node_modules/npm/bin/npm-cli.js ci --no-audit --no-fund
# build: exit 0, 15.007s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/.npm/_npx/6416243750526179/node_modules/npm/bin/npm-cli.js run build
# typecheck: exit 0, 22.606s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/.npm/_npx/6416243750526179/node_modules/npm/bin/npm-cli.js run typecheck
# lint: exit 0, 11.250s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/.npm/_npx/6416243750526179/node_modules/npm/bin/npm-cli.js run lint
# inventory-check: exit 1, 10.609s
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/orca/engineering-vault/tools/engineering-map.mjs docs:check
```

Electron binary download is not required for the requested backend scope; allowed native scripts and dependencies are installed. Build includes backend and dashboard. No backend test is filtered/skipped/retried.

## Build identity and inventory

Build source HEAD: 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f; source dirty: false.
Input digest: sha256:0c9a5706f4144e24c2e26551c57b35b63abff17bfae27fe6414286ae633aa540.
Backend artifact digest: sha256:cad0e1a4b4396d3ce9afdb7e47c78581eb8f1f76d7db09456837069d2d78c389.
Complete dist inventory: 1703 files, 10667979 bytes. Manifest SHA-256: 51af28067218952385bda5d21d15d6fbc7efe10ad4abf08d4f6282fb5588ffe6. The full TSV lists every path, byte size and SHA-256: [complete artifact inventory](jarvis-clean-deploy-candidate-20261007-artifacts.tsv).

## Excluded work and residuals

The shared checkout's 19 uncommitted tracked files are not copied:

```text
 M src/control-plane.ts
 M src/dashboard/api-routes.ts
 M src/dashboard/control-request-read.ts
 M src/dashboard/main.ts
 M src/dashboard/memory-mutation-routes.ts
 M src/dashboard/memory-read-routes.ts
 M src/dashboard/personal-details.ts
 M src/dashboard/personal-routes.ts
 M src/dashboard/personal-today.ts
 M src/dashboard/post-routes.ts
 M src/dashboard/server.ts
 M src/memory-read-fence-production.ts
 M src/memory-read-fence.ts
 M src/recommendation-work-identity.ts
 M src/recommendations.ts
 M src/task-work-lineage-visibility.ts
 M src/workflow-stage-outcome.ts
 M tests/integration/dashboard-control-page.test.ts
 M tests/integration/recommendations-create.test.ts
```

Shared untracked work, ongoing wC/jarvis-backend changes and unmerged PR63/other PRs are excluded. PR61 enters only through the required origin/main merge.

canonical_digest coverage gap: swap helper(replaceStoredProvenance)가 envelope JSON을 다시 쓰면서 digest를 갱신하지 않음. Not fixed.

Canonical inventory docs:check reports 37 pre-existing findings (exit1), excluded from repair, not green:

```text
missing-child mail-identity-review-20261006
missing-child workspaces
uncovered-entrypoint ep-proj-dev-wiki-cli-emit-test-cli-mjs-23
uncovered-entrypoint ep-proj-dev-wiki-cli-probe-cli-mjs-36
uncovered-entrypoint ep-proj-dev-wiki-cli-tick-cli-mjs-42
uncovered-entrypoint ep-proj-dev-wiki-cli-follow-cli-mjs-80
uncovered-entrypoint ep-proj-dev-wiki-cli-bridge-cli-mjs-109
uncovered-entrypoint ep-proj-dev-wiki-cli-ack-cli-mjs-151
uncovered-entrypoint ep-proj-dev-wiki-cli-resolve-cli-mjs-151
uncovered-entrypoint ep-proj-dev-wiki-cli-ack-cli-mjs-155
code-changed proj-orca-jarvis-feat-signed-approval src/control-plane.ts
code-changed proj-orca-jarvis-feat-dashboard dashboard/src/root.tsx
code-changed proj-orca-jarvis-feat-dashboard src/dashboard/main.ts
code-changed proj-orca-jarvis-feat-dashboard src/dashboard/api-routes.ts
code-changed proj-orca-jarvis-feat-second-brain-memory src/dashboard/memory-mutation-routes.ts
code-changed proj-orca-jarvis-feat-recommendation src/dashboard/personal-routes.ts
code-changed proj-orca-jarvis-feat-recommendation src/dashboard/post-routes.ts
uncovered-entrypoint ep-proj-orca-jarvis-http-api-server-ts-230
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-111
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-112
uncovered-entrypoint ep-proj-orca-jarvis-gui-memory-root-tsx-113
uncovered-entrypoint ep-proj-orca-jarvis-gui-security-root-tsx-114
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-115
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-122
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-123
uncovered-entrypoint ep-proj-orca-jarvis-gui-memory-root-tsx-124
uncovered-entrypoint ep-proj-orca-jarvis-gui-overview-root-tsx-125
uncovered-entrypoint ep-proj-orca-jarvis-gui-tasks-root-tsx-126
uncovered-entrypoint ep-proj-orca-jarvis-gui-tasks-taskId-root-tsx-136
uncovered-entrypoint ep-proj-orca-jarvis-gui-proposals-root-tsx-148
uncovered-entrypoint ep-proj-orca-jarvis-gui-agents-root-tsx-149
uncovered-entrypoint ep-proj-orca-jarvis-gui-agents-agentId-root-tsx-159
uncovered-entrypoint ep-proj-orca-jarvis-gui-approvals-root-tsx-163
uncovered-entrypoint ep-proj-orca-jarvis-gui-security-root-tsx-176
uncovered-entrypoint ep-proj-orca-jarvis-gui-finance-read-root-tsx-177
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-178
uncovered-entrypoint ep-proj-orca-jarvis-gui-item-root-tsx-180
```

Vite emits an existing >500kB chunk warning; build exits0 and no budget changes. Production deployment, services and live use are NOT_RUN.

## Full backend acceptance

Command (one execution, no file selector, shard, retry, timeout override or bail):

```bash
cd /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007
node /home/jm/.npm/_npx/6416243750526179/node_modules/npm/bin/npm-cli.js run test:backend -- --no-file-parallelism --reporter=default --reporter=json --outputFile=/home/jm/.omo/evidence/jarvis-clean-deploy-candidate-20261007/backend-vitest.json
```

Exit: 0; elapsed: 1960.054 seconds.
661/661 files and 4565/4565 tests passed; fail=0, pending/skip=0, todo=0; skip_added=0.
The existing backend profile excludes two GUI files; none of the configured backend suite was filtered out. The runner's existing 2400000ms process budget and default 5000ms individual test budget were unchanged. Reporter arguments bypass only the runner's automatic two-shard wrapper, selecting the whole backend profile in one invocation.

Raw backend log SHA-256: 79ad078724533e0546e72d8e80e347d9aae8a1987d305c6856597a61c33ea1ea.
Machine report SHA-256: 30516017f00266ffd1d286fbdb3589d77697ae9730ab5379376106457a267df2.

Original log excerpt, lines 2060-2065:

```text
 Test Files  661 passed (661)
      Tests  4565 passed (4565)
   Start at  00:49:30
   Duration  1959.05s (transform 6.80s, setup 0ms, collect 304.21s, tests 1553.75s, environment 74ms, prepare 28.26s)

JSON report written to /home/jm/.omo/evidence/jarvis-clean-deploy-candidate-20261007/backend-vitest.json
```

No failed test needs fixing. Both tests/integration/recommendations-exception-remediation.test.ts (5 tests) and tests/integration/memory-correction-control.test.ts (11 tests) passed unchanged. No test body, assertion, skip, retry, timeout, source or configuration was modified.

## Clean and protected work proofs

After all requested commands, before adding this evidence, these commands returned0 with empty stdout:

```bash
git status --porcelain
git diff --exit-code 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f
git diff --cached --exit-code
```

All 1703 build artifact rows remain byte-identical after the full suite. Lockfile SHA-256 is unchanged. Shared checkout branch/HEAD/status and SHA-256 of git diff --binary HEAD match the initial snapshot: a3031d608021c8048692648a4900f26fdf94d97a32ef431fad13d0d7eb1d116b. PR63 local branch/HEAD/status also match.

During the 32.668-minute backend execution, another task changed remote PR63 from draft OPEN to MERGED and updated its body; its code head remains 7300770e39cf41c4e2bf6eda7725e7c8307491bf. This task made only read requests to PR63 and did not merge, promote, edit or revert it. Remote main now points to a0ba5165c941dba4acc28a484b9e1d5db2366344; this candidate deliberately stays frozen at the originally fetched base and does not import PR63. Initial and final snapshots distinguish these facts.

## Candidate identities and publication receipts

Exact measured candidate branch HEAD before documentation: 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f. Its built source tree is 16e7a1d128dba685faaa01cbe061389e4c45c4d7. Documentation commits do not change that source. A committed document cannot embed its own final commit hash without a circular identity; the full publication HEAD SHA and final clean git status observation are therefore recorded in the PR body after commit, alongside this exact measured HEAD. Build identity and local acceptance refer to the frozen code HEAD, not to a hypothetical later rebuild. CI runs/status/conclusion and whether they test a PR merge ref are recorded in the PR body without presenting pending CI as green.

## QA and scope review

| Criterion | Observed evidence | Verdict |
| --- | --- | --- |
| Frozen isolated origin/main base with PR61 ancestor | Fresh fetch 7669b34e; empty initial status; independent Orca worktree | PASS |
| Frozen install and complete build | install-direct exit 0; build exit 0; original lock hash and build metadata | PASS |
| Typecheck and lint | Each exit 0, retained transcripts and SHA-256 | PASS |
| Full backend once | backend exit 0; 661 files; 4565 passed; 0 skips/failures; no test delta | PASS |
| Complete artifacts and exclusions | Full 1703-row TSV and SHA-256; 19 dirty files, wC and PR63 excluded | PASS |
| Protected shared and Task18 work | Local snapshots and shared diff hash match; external remote transition disclosed | PASS |
| Production and authority boundaries | No live service, deployment, merge, ready transition or environment write | PASS |

This is an evidence-only change. There is no new production logic, helper extraction, dependency, error suppression, new test, removed test, prose-pinning assertion, or altered machine-consumed contract. The programming and overfit/slop perspectives identify no new behavioral change. Final independent review is recorded in the external task evidence and the draft PR.

## Handoff note (윤비서, 2026-10-08 01:26 KST)

wK JARVIS 깨끗한 배포 후보 기준 SHA는 `7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f` 유지, 후보는 PR63 미포함. 새 main과의 차이는 PR63 테스트 1파일 +2/-2(`tests/integration/recommendations-exception-remediation.test.ts`)뿐.

참고: main `a0ba5165` 머지 후 CI run 37651032844 실패는 코드 문제가 아니라 GitHub 결제/지출 한도 차단("The job was not started because recent account payments have failed or your spending limit needs to be increased.")으로 러너가 할당되지 않은 것임.
