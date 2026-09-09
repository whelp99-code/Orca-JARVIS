# Read-only performance and routing reports

The CLI's task-performance and routing-shadow reports previously opened a writable
AuthorityDb. On a DELETE-journal file, constructor setup changed journal mode to WAL
before the reader ran. Two new full-command regressions reproduced byte changes.

Both commands now reuse the readonly/fileMustExist connection path introduced for
remote-audit history. Existing input validation, migration readiness, report data
and evidence calculations remain unchanged. Normal execution commands retain the
writable path. This change is restricted to the three explicitly identified reports;
it does not claim every JARVIS status/inspection surface is read-only.

Regression before fix:2failed. After fix: report-readonly/performance/routing-shadow
11tests passed. All3typechecks, targeted ESLint and backend build exited0. Actual
compiled task-performance and routing-shadow processes each exited0 against one
isolated DELETE-journal database; exact file bytes remained unchanged after each.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/reports-readonly-live.json.
No production database or service was modified. This is a small extension of the
previously independently reviewed readonly constructor path, not a new DB mechanism.
