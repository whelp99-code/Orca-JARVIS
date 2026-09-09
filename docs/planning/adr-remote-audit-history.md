# Minimal remote audit history

Status: implemented and independently reviewed; no operational activation.

`report remote-audit EVENT_ID --db EXISTING_PATH` reports active, retired or
not_found. CLI accepts only db/json flags and exactly one event ID, requires an
existing database file, and checks migration readiness. No migration, retention
execution, authority redemption or provider call is performed by this command.

The reader uses one deferred read transaction. Active history reports stored_event
and only event ID/digest/type, outcome/reason and timestamp; it does not certify
original cryptographic verification. Retired history verifies the applying batch's
persisted authorization digest and identifier, completed job/fence/cutoff binding,
and final retention receipt digest over batch counts. All batch records are used
in canonical original ordering with a1001-row rejection bound. A broken binding
fails REMOTE_AUDIT_HISTORY_INVALID instead of becoming not_found or an empty event.
Legacy-null outcomes remain unknown. Private principal, subject, request, assertion,
credential and correlation columns are not returned. Event IDs remain linkable
security identifiers as documented by the retirement policy.

verified_retirement_bindings means consistency with the retained local ledger;
it is not a signature or a claim that arbitrary database-owner tampering is detected.
The immutable schema and host database boundary remain trusted.

Focused adapter/history/reviewability10tests passed. They check zero total_changes
for active, missing, retired and invalid-binding reads. Typecheck, targeted ESLint
and backend build exit0. Compiled CLI acceptance on two separate file-DB actors
returned retired/verified_retirement_bindings, with identical serialized database
bytes before/after both reads and FK0. Restart claimed0 additional jobs. A separate
missing-path process exited2 with REMOTE_AUDIT_HISTORY_DATABASE_UNAVAILABLE and
created no database file. No production data or service was changed.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-history-live.json.


Migration083 adds an authorization_id,created_at,event_id index for the verification
batch. EXPLAIN changed from full retired-table SCAN plus temporary sorting to
SEARCH USING INDEX remote_audit_history_authorization(authorization_id=?), without
a temporary sort. Adapter/history/allocation9tests passed after adding the index;
backend build exit0 with90migration files. This is query-plan evidence, not a
production latency measurement. The index does not change evidence or eligibility.

Final CLI open hardening uses AuthorityDb fileMustExist=true for this report,
so disappearance after the initial stat cannot create a new DB. Final typecheck,
ESLint and backend build exited0; compiled two-process CLI verification repeated
with identical serialized DB bytes, retired history and FK0 in both actors.
Independent review remains pending; no completion or operational activation claim.


Review remediation: fileMustExist alone allowed AuthorityDb.configure to change
non-WAL DBs to WAL. The report now opens SQLite readonly:true and fileMustExist:true;
AuthorityDb skips journal conversion on readonly handles and preserves options on
reopen. Default writable connections retain their prior behavior. A real non-WAL
file test verifies readonly/reopen, write rejection and byte equality; adapter/history
9tests passed. Initial timeout was expensive Buffer deep comparison; Buffer.equals
retains exact byte comparison and the same test passes678ms without timeout changes.
Final typecheck/ESLint/build exit0. Compiled CLI on two DELETE-journal actors returned
retired history, unchanged serialized DB bytes, journal_mode=delete and FK0 in both.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-history-readonly-live.json.

Independent runtime_probe_review rereview: ship, no actionable findings after
readonly remediation. Review covers CLI open/reopen behavior, minimal fields,
full bounded batch verification, failure semantics and083query index.
