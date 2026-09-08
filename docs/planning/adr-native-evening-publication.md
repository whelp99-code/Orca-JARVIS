# Native evening publication — implementation contract

Status: local store implemented and reviewed; runtime wiring pending.
This targets the native half of backlog 12; full
evening sections, retention, scheduling and the complete 01–25 scope remain open.

## Existing boundaries inspected

- EveningCloseoutStore accepts v1 only; native envelope has separate durable and
  current-source verifiers. DailyLoopStore already guards fence/lease/integrity.
- The generic daily projection binder does not parse source_json string contents.
- MemoryProjectionAuthority.inherit copies memory target dependencies, not a live
  edge to the parent. Later direct quarantine of a task ID therefore needs live
  source checking even when target dependencies were copied at publication.
- The native source reader applies visibility checks to request/run/completion/
  publication/verification/artifact IDs and revalidates original certification.
- Today verifies v1 only. Daily usage supports v2 in the separate usage change.

## Required implementation

1. A native publisher uses one immediate transaction for live source validation,
   exact run/date/correlation binding, lease/fence checks, step persistence,
   dependency binding, actual daily usage checking and completion. A failure after
   any intermediate write must roll back all writes.
2. Repository scopes and source limits come from trusted runtime configuration.
   Signed artifact scopes alone are not caller authorization. Publication compares
   the expected configuration to the artifact before accepting its source.
3. Resolve source task IDs only from the live-validated original records. Copy
   existing memory dependencies for all relevant IDs to daily_run/daily_step/
   evening_closeout projections. Read back exact dependencies: target-only primary
   keys can silently discard distinct source identities. Reject ambiguous lineage;
   never invent a memory target from a task ID. Absence of recorded lineage does
   not prove a task never consumed memory; runtime source admission must preserve
   this limitation until an explicit provenance contract exists.
4. Native read/display uses a single read snapshot for run/step/projection checks
   and live source verification. Durable signature verification alone is only for
   persisted cost accounting. An invalidated original cannot appear as completion.
5. Replay with identical completed artifact returns unchanged only under the
   existing identity contract; conflicting bytes reject. A failed publication
   cannot make an artifact appear completed through a generic placeholder.

## Acceptance evidence required

- Real native completion fixture → generated report → published step/run → DB
  reopen → verified read, preserving original signature bytes.
- Exact configured scope mismatch, wrong key, changed source, stale fence,
  lease/deadline expiry, byte/item/work budget: publication rejected or rolled back.
- Injected interruption after persistence: no partial completed output; retry with
  valid fence succeeds once, duplicate does not charge twice.
- Memory-target suppression and direct task quarantine after publication each
  prevent display; already published durable usage remains unchanged.
- Read path total_changes unchanged. Compiled subprocess evidence and source
  fixture provenance reported separately from production activation.

Automatic operation stays HOLD until this contract, Today integration and actual
configured runtime validation are implemented. This is not a new approval request
and does not cancel authorized local development.

## Local implementation evidence

NativeEveningStore now performs configured scope/limits comparison before live
source access and publishes the report, dependencies, completion and daily budget
inside one immediate transaction. Read and replay check original source validity,
clock ordering and exact report dependencies. Legacy task sources without recorded
control_payload provenance reject; no fictitious memory target is created. Runtime
provenance admission and Today/service wiring remain required, not silently enabled.

The lineage helper caps source dependency collection at 1,024 unique identities
and rejects the existing target-only primary key's loss of alternate source identity.
It preserves direct-source checking separately from copied target dependencies.

Before the final read-lineage guard: related native/v1 integration 20 passed
(17.88s). Final native integration: 6 passed (9.95s), including a compiled Node
subprocess opening the same isolated DB and reading the original source digest.
Scenarios cover missing provenance, successful/replayed publication, read writes=0,
item/work/byte budget rollback, injected interruption, stale fence, lease elapsed
during publication, wrong configuration/key, target suppression, direct quarantine,
identity collision, clock regression and generic publication bypass rejection.
Backend build exit 0: 1,102 artifacts, 72 migrations. These are synthetic origin
fixtures with real Git/SQLite/Node operations, not production acceptance evidence.

Fresh review `/root/native_evening_store_review` returned fix-first for empty
reports: no memory dependencies could not distinguish native publication from a
generic completed step. Correction preserves empty reports and adds forward
migration 073 with immutable native publication records bound to run, step,
artifact digest and publication time. Read/replay require this record. It commits
in the same transaction and is included in rollback snapshots. No shipped SQL
bytes changed. Post-correction native + migration integration: 15 passed (14.02s),
including empty native success/generic bypass rejection; build exit 0 with 1,103
artifacts and 73 migrations. Final lint and all TypeScript checks exited 0.
Fresh acceptance remains pending after the correction.

Second review correction: report lineage must equal the expected dependency set,
not merely contain it. Extra preexisting report targets now reject and roll back;
the new regression checks pending step, no publication row and unchanged lineage.
Post-correction native integration 9 passed (15.39s), backend build exit 0 with
1,103 artifacts/73 migrations. Final lint and all TypeScript checks exited 0.
Fresh review `/root/native_evening_store_acceptance_review` returned ship with
no acceptance blocker. Requested gpt-5.6-terra/high; realized model/effort were
unobservable. This accepts the local store unit, not runtime or full-goal completion.
