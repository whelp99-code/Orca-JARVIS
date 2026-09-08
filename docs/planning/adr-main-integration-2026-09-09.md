# JARVIS / Second Brain consumer integration candidate

## Pinned parents and scope

Development parent: aae919a2bb510ef02be47a7cb2f9d9e7fd33846a.
Main snapshot: 9ab82930061195fa53588a84fb527019b35f140c.
Merge base: d94a4f953bab39d5220b99cfa4daa9a5e1cb8791.
Before merge, main-only52/development-only78 commits. The main workspace has
unrelated AGENTS.md/untracked local changes and was not edited. The candidate is
in codex/priority-deadline-evidence, merged with --no-commit, pending full checks
and independent acceptance. Main continuing past the pinned snapshot is separate.

Incoming125files (80added/45modified),4698insertions/138deletions. Git reports no
text conflicts; this is not proof of semantic integration. Main adds scoped memory
read/write-policy preparation, authentication session plumbing, automatic-candidate
publication and durable cancellation/compaction. Existing development work adds
execution templates, performance reports, daily lifecycle fixes, runtime identity,
retention policy, build permissions and test infrastructure. Both must coexist.

## Evidence before full verification

- Candidate backend build/lint/3typechecks exit0(handle92855). Build1204artifacts,
  migration_count80, input sha256:fa2d46a237a8ca942389ad6cb148ab95fa4d3ede8ba53adee59884f478e5c0f1,
  artifact sha256:9ced75e465d46fc433c7a243cc9f0a7cc4af33de61c4d5c954d3006afea15002.
- All75development SQL files and76main SQL files retain exact bytes from their
  respective parents; no historical SQL edited. Four numeric prefixes overlap
  (072–075), but their full filenames are distinct. Runtime journal uses full
  filenames; the combined lexically ordered80-file vector requires actual tests.
  Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/main-integration-migrations.json.
- Static emitted-ESM relative import graph589modules/2105edges/0cycles; public
  index882exports. Dynamic/require/external edges are outside this measurement.
  /home/jm/.cache/jarvis-test-runtime-qa-20260908/main-integration-graph.json.
- Actual cancellation acceptance52369 exit0: five separate Node actors / isolated
  SQLite. Committed cancellation survives actor exit77 and replays canonically;
  later claim refuses MEMORY_REQUEST_CANCELLED. Claim-first refuses cancellation
  with MEMORY_CANCELLATION_UNSENT_UNPROVED and creates0intents. Original spool
  preserved, provider calls0. Provider submission/settlement is not activated.
  Receipt: /tmp/cancellation-db-acceptance-gaaiBl/result.json.

## Acceptance still required

Run canonical npm run verify over this frozen candidate, diagnose any integration
failures, inspect complete incoming changes and obtain fresh independent review
before committing the merge. Re-run actual task execution and relevant memory
contract/CLI acceptance on the accepted candidate. Existing operational activation,
real connector, privacy lineage and full01–25 remaining requirements remain open.
No production DB/config/deploy/restart or Second Brain provider source edits here.

## Integration remediation

The initial full gate's first shard finished1604passed/15failed. The remaining
shard was explicitly stopped to repair verified failures; this run is not a pass.
Build fixtures lacked newly required contracts, the numeric migration test did not
allow the four immutable parent collisions, and source reviewability gates rejected
ten modules. Preserve those gates and split command staging, database replacement,
phone request authentication and duplicate evidence resolution by responsibility.
Wrap long expressions without changing wire contracts or SQL bytes. Fix the new
CLI parser's malformed Unicode path acceptance and use cursor claim/accepted APIs
in the cancellation test instead of an idle cursor update forbidden by migration076.
The initial targeted fixture/migration/cancellation run passed34tests across4files.
After extraction, the broader focused run passed109 and failed1: after_disposal
exceeded its default5000ms budget at5074ms. Give only the three multi-build recovery
cases a15000ms test budget; no assertions, runtime watchdogs or authority expiry
changed. The final isolated compaction rerun(handle56742) passed11/11 in36.70s,
including after_disposal5078ms. Lint and all3typechecks passed(handle49001);
reviewability and Unicode regression checks passed15tests/3files(handle72878).
Actual isolated upgrades from both pinned parents reached80migrations and identical
925schema objects, retaining226/231old tables and84/85default rows respectively;
integrity ok and foreign-key violations0. These are default-row fixtures, not a
populated production migration rehearsal. Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/merged-schema-upgrade-e6wa44/receipt.json.
Final full checks and independent review remain required.


## Completed remediation verification and remaining final gate

The second full gate(handle30687) terminated exit1 with unchanged tracked bytes
and HEAD. Shard1:1619passed/234files/740.03s. Shard2:1628passed/1failed/233files/
725.16s. The only failure was remote-approval-migration-allocation's second numeric
uniqueness assumption. Preserve its filename grammar and contiguous unique prefix
checks while allowing only the same four explicitly named immutable parent pairs.
Dashboard/acceptance/smoke were not reached by this failed run.

Direct scoped response consumers also accepted lone-surrogate page IDs (compiled
probe7c9fa2). The production wire decoder already rejected both malformed values
(probe855743), so this is a direct consumer/alternative transport boundary defect,
not a demonstrated production wire bypass. Add isWellFormed to page identity
validation. New regression3failed/17passed(handle75419); corrected scope/migration
suite23passed/4files(handle18023). Scoped client/transport/strict JSON/reviewability
suite13passed/5files(handle96363). Backend build/lint/3types exit0(handle43685).
Compiled direct-read/search acceptance8519ed preserved4normal IDs and refused6bad
IDs; wire decoding also matched. Provider calls0; synthetic response/read fence.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/scoped-page-unicode-acceptance.json.

The merged build before the final page-ID guard completed real Claude1/verifier1
technical-review execution in42193ms(handle50888). Result commit
7f5485fc9c19eaab357192c5800b094333168f0f is in an isolated fixture repository, not
this source branch. Replay extra calls0, original HEAD/status/source preserved,
read-only performance report1/1. Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-hRRbk7/receipt.json.
Current merged cancellation issuance acceptance46550 exit0 used5Node actors;
exit77 after commit replays identically, later claim refuses, claim-first issuance
refuses with0intents, provider calls0/spool preserved. This does not test physical
DB swap or provider settlement. Receipt: /tmp/cancellation-db-acceptance-MDIoAg/result.json.

Final full verify and fresh read-only independent review are still pending.
No source-branch merge commit, production activation or full01–25 completion yet.


## Final full gate result

Final npm run verify56886 terminated exit0. Backend1623/234files +1629/233files
=3252tests; dashboard252/36files; total3504tests/503files. Runtime/lint/3types,
backend/dashboard build, fixed-clock acceptance and CLI smoke completed. Wrapper
verified identical HEAD and tracked file bytes before/after. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-main-final-after.json.
Log: /home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-main-final.log.

Additional isolated parent-SQL upgrade2024 exit0 seeded pending command/event and
retention job(3business rows each). Both75/76→80 preserved12nonjournal rows across
225/230original nonjournal tables, retained approval refusal and null legacy cutoff,
repeated migrate unchanged; integrity ok/FK0. This uses current runtime with parent
SQL, not old binaries or a production DB copy. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/populated-parent-upgrade-GJWToj/receipt.json.

Read-only systemd observation: authority/dashboard/phone loaded+active; morning and
evening timers not-found. Authority declares localhost IP allow and all-IP deny;
actual cgroup network enforcement was not probed. Real shell Claude acceptance must
not be presented as service activation acceptance. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/merged-operations-readonly.json.

Independent review and source merge commit remain pending. Full01–25 operational,
connector, memory-source privacy and outcome-metric gaps remain open.


## Integration acceptance

Fresh read-only reviewer /root/main_merge_review returned ship, blocking findings0,
matching all135 staged file hashes. Requested gpt-5.6-sol/high; realized model/effort
were not exposed. Reviewer did not rerun tests. Parent browser E2E50525 exit0,
26passed/1.1m across1440px and1024px, including approve/execute/replan/retry and
axe serious/critical0 plus no overflow. No source changes after the full gate;
subsequent changes only record evidence in this ADR and the execution journal.

Accept the pinned integration for a source merge commit. Later main53c67b1's seven
commits(17files) are excluded. This acceptance does not complete the full backlog
or authorize/claim production activation. Review receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/main-merge-review-result.json.
