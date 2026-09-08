# Routing CLI JSON input boundary

2026-09-09; backlog20/21/24.

The classify request/policy, executor-plan validation and template compilation CLI
share one bounded file reader. JSON.parse silently accepted duplicate keys, including
conflicting objective/provider/template_id values. Replace only this decoding step
with the existing strict-json parser. Preserve byte caps, fatal UTF-8, regular-file
and no-follow/nonblocking handling, command schemas and no-execution semantics.

Limits: depth32, nodes8192, workItems32768, characters bounded by each command's
existing byte cap (8KiB/64KiB/4MiB). Valid contracts fit within these structural
budgets: routing16rules×32keywords, execution128files/8checks×64arguments, and
shallow template bindings. No new format or mutable decoder is introduced.
Duplicate decoded keys (including escaped spellings), nonfinite numbers, lone
surrogates and over-budget documents return WORK_ROUTING_INPUT_INVALID without
raw file contents. This is offline validation, not execution authorization.

Regression before fix: all3 CLI commands accepted duplicate top-level keys;
3tests failed because the calls resolved successfully instead of rejecting.

Final validation: backend build,47tests/6files11.62s, lint and3TypeScript checks
exit0(handle45077). Each command retains a valid-input check and rejects ordinary
and escaped duplicate keys. Existing symlink/FIFO/UTF-8/file-cap checks pass.
Compiled CLI real processes:3valid calls exit0,3duplicate calls exit2, no database
files created and no conflicting private input echoed. Separate compiled checks:
duplicate policy rejected; valid128-file/8-check/64-argument plan accepted.
No model invocation or production mutation. The cumulative verify frozen at
80f58a5 is still running and excludes this change.
