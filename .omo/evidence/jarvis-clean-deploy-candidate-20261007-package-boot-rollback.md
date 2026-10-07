# Candidate packaging, isolated boot and isolated rollback

## Outcome

**BLOCKED at step 1. Deployment preparation remains incomplete.**

The executing agent supplied an invalid isolated npm configuration: both
`npm_config_userconfig` and `npm_config_globalconfig` name `/dev/null`.
The candidate dependency-install command exited 1 before dependency installation
or the repository packaging script could start. This is an operator/control
environment error, not a failure observed in the candidate application code.

Per the user's explicit no-fix/no-rerun instruction, the configuration was not
corrected and the failed command was not repeated. No package was produced.
Boot and rollback were not run. No successful package/boot/rollback evidence is
claimed and the three restored Issue64 acceptance criteria remain open.

## Pinned candidate and previous target

- Original candidate worktree:
  `/home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007`.
- Existing branch: `release/jarvis-clean-candidate-20261007`.
- Candidate HEAD at task start and before adding this report:
  `936a24f322974e6efd1893d0da91424f3bf18f3a`.
- Code baseline: `7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f`;
  PR61 included, PR63 not imported.
- Intended exact prior package target:
  `7f2bdf081f66aadd19c45b29d27dfe4e399b23f1`.
  Only its isolated source snapshot was prepared; this is not a prior package
  or rollback execution receipt.

Initial `git status --porcelain` was empty. The only baseline-to-HEAD changes
were the two already committed evidence documents; source, tests, configuration
and lockfile were unchanged. This update adds only this evidence document.
Publication HEAD and final clean status are recorded in the PR after commit to
avoid a self-referential commit hash.

## Existing-record review

The candidate's existing `.omo/evidence` files and the prior task's control
receipts were checked for same-SHA package paths/runtime-package receipts and
successful boot/rollback results. Matching shell-record command metadata was
also checked without printing raw command lines or credential values.
No same-candidate package/isolated-boot/rollback execution receipt was found.
The existing build-only evidence and older Task36/different-SHA history were not
counted as this task's execution evidence.

Search receipt:
`/home/jm/.omo/isolated/jarvis-candidate-936a24f/control/existing-evidence-search.json`.

## Isolation contract and preparation

All generated control files, Git snapshots, dependency caches, logs, TMP, HOME,
configuration paths and runtime-data paths are under:

`/home/jm/.omo/isolated/jarvis-candidate-936a24f`

The existing `scripts/package-authority-runtime.mjs` builds its working tree;
therefore isolated independent local clones were prepared instead of running it
against the original candidate worktree. Their Git objects are copied, not
hardlinked to the source. Exact detached heads are the candidate and prior target
above. No existing source branch was switched or changed.

The plan uses the existing packaged dashboard CLI and health endpoint with an
explicit isolated environment and port 0. The existing packaged HTTP probe drops
HOME/root overrides when constructing its child environment, so it was not
executed. The planned existing release rollback/restore contract was not run.
No production service, production HOME/DB/port, systemd or launchd was accessed.

Boundary/profile receipt:
`/home/jm/.omo/isolated/jarvis-candidate-936a24f/control/plan.json`.
Environment controls include isolated HOME/XDG/TMP/npm cache and all authority/
provider roots, providerless paths, and an isolated npm executable wrapper.
No token, password, private key or `.env` value is included in this report.

## Actual commands and results

Each command ran with the explicit environment in `control/plan.json`, with logs
and result JSON written only under the isolated `logs` directory.

| Command label | Exit | Duration ms | Result |
| --- | ---: | ---: | --- |
| clone-candidate | 0 | 1224.453 | Independent isolated candidate source copy |
| checkout-candidate | 0 | 190.676 | Detached at exact candidate HEAD |
| clone-prior | 0 | 153.130 | Independent isolated prior source copy |
| checkout-prior | 0 | 180.943 | Detached at exact prior target |
| install-candidate | 1 | 68.676 | Failed before dependency install |

```bash
git clone --no-hardlinks --no-checkout \
  /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007 \
  /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate
git -C /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate \
  checkout --detach 936a24f322974e6efd1893d0da91424f3bf18f3a
git clone --no-hardlinks --no-checkout \
  /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007 \
  /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-prior
git -C /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-prior \
  checkout --detach 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1
cd /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate
npm ci --no-audit --no-fund
```

The npm wrapper invokes Node 24.19.0 and the existing cached npm 11.17.0 CLI.
Exact raw failed-command stdout/stderr:

```text
Exit prior to config file resolving
cause
double-loading config "/dev/null" as "global", previously loaded as "user"
```

Failure log:
`/home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/install-candidate.log`.
SHA-256:
`250e369d730a46c4d41df37449a5c58c169b4b1d2ab546951a8bed0285805a95`.
Full exit/time/argv receipt: sibling `install-candidate.json`.
Terminal assessment: `control/terminal-failure.json`.

## Required observations left unverified

| Required observation | Actual state |
| --- | --- |
| Candidate package path/file count/bytes | NOT_CREATED |
| Whole package/archive/manifest SHA-256 | NOT_CREATED |
| Packaged executable hashes | NOT_CREATED |
| Owned boot PID and non-production port | NOT_RUN; no server spawned |
| Health response/startup duration | NOT_RUN |
| Orderly server shutdown/exit | NOT_RUN |
| Actual prior package SHA-256 | NOT_CREATED |
| Candidate-to-prior rollback | NOT_RUN |
| Post-rollback restart and health | NOT_RUN |
| Schema/data preservation | NOT_RUN |

Source snapshot success is not substituted for packaging. Existing backend
4565/4565 results are not substituted for boot or rollback. No mocked health,
old receipt, empty-directory digest or synthetic successful result is used.

## Acceptance and publication boundaries

Issue64's previously missing packaging, isolated boot and isolated rollback
criteria were restored. Its body update first hit a GraphQL server error; a
REST update succeeded and was requeried. Project was returned to In Progress
and must not be marked Done while the three acceptance criteria remain open.
PR65 remains draft and its assessment remains build candidate verified,
deployment preparation incomplete.

The sole active shared Git hook is `post-commit`; it invokes canonical inventory
`docs:sync` and appends `/home/jm/orca/engineering-vault/proof/hook-last.log`.
That writes outside the allowed output roots. The evidence commit therefore
uses a per-command isolated empty hooks directory, with no repository config
file change. No test/typecheck/lint hook is disabled, no failure is suppressed,
and inventory synchronization is explicitly NOT_RUN for this evidence commit.

No production operation, source/test/config/lockfile edit, merge/ready transition,
force push, other branch/PR modification or main-checkout dirty-file edit is
authorized or performed. The original failure is preserved and no corrective
validation attempt was made.

JARVIS_CANDIDATE_PKG_BLOCKED reason=npm_configuration_double_loading step=1
