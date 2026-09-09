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
