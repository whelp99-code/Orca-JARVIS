# CLI option validation

Actual timeline CLI verification used --max-bytes instead of the registered
--max_bytes. Non-strict parseArgs accepted the unknown option and the command used
the default byte budget, returning 569 rather than the expected 1000 events.

Decision: use strict Node argument parsing before normalization, dispatch or database
construction. Unknown options, missing string values and invalid boolean assignments
raise CLI_ARGUMENT_INVALID. Do not include argument values in the public error.
Help remains an early read-only response. Registered options and positionals retain
their existing names; this does not add hyphen aliases or per-command option schemas.
Duplicate known options and excess positional arguments are outside this change.

Validation: argument/help/Codex-Claude vertical tests passed 3 files / 8 tests;
typecheck, zero-warning lint and backend build exited 0. Five invalid argument cases
reject before creating a missing DB. Three separate compiled CLI processes return
exit2, empty stdout, CLI_ARGUMENT_INVALID and no DB creation; a private fixture value
is absent from error output. Local receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/cli-invalid-arguments-result.json.

Compatibility: invocations relying on unknown options being ignored now fail. Use
--max_bytes, as documented, rather than --max-bytes. Known option validation inside
individual command handlers continues to apply. No production configuration changed.

Independent read-only review /root/refresh_receipt_review returned ship with no
required corrections. It confirmed parsing precedes AuthorityDb construction and
registered options match normalized CLI values. Explicit -- positional handling is
unchanged and is not covered by the invalid-option no-DB guarantee. Reviewer model,
effort and API token usage are unobservable in runtime telemetry.

## Expanded command compatibility

A 13-file command integration run passed 75 tests and failed 3 of 78: daily,
team and routing tests expected command-specific errors for globally unknown flags.
Updated only those expectations to CLI_ARGUMENT_INVALID; registered but irrelevant
options retain their existing command-specific errors. The corrected three files
passed all 30 tests in 19.56s. Combined with the unchanged ten files, all 78 scenarios
have passing evidence across these runs; this is not an uninterrupted 78-test run.
An intermediate fixture edit accidentally referenced flag outside its loop; diff
inspection found and reverted it before the successful rerun. Product code did not
change during this compatibility correction. Logs in the local QA directory:
cli-strict-compatibility.log and cli-strict-compatibility-fixed.log.

## Canonical acceptance at 87390b2

Uninterrupted npm run verify (session 97701) exited 0 at
87390b2874365db68ade410d1f61ad0bda610dee. Backend shards passed
261 files / 1817 tests (594.88s) and 261 files / 1848 tests (534.69s);
dashboard passed 37 files / 255 tests (33.62s): 3920 tests total.
Runtime, lint, typecheck, build, fixed-clock acceptance and CLI smoke completed.
Acceptance emitted pre_gjc_ready, stopped, completion_promoted=true and
gjc_dispatched=false. Before/after comparison checked 1814 tracked file hashes:
0 changes and identical HEAD. The untracked node_modules link remained present.

Evidence directory /home/jm/.cache/jarvis-test-runtime-qa-20260908:
verify-cli-before.json, verify-cli-87390b2.log, verify-cli-result.json.
This verifies CLI argument validation and its command compatibility changes;
it does not establish collector activation or completion of backlog 01–25.
