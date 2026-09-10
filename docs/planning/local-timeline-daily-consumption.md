# Local timeline to daily report: consumption boundary

Status: implementation design; no automatic bridge is enabled.
Inspected JARVIS source at 30cc249 on 2026-09-10. Backlog12/23 remain incomplete.

## Existing code and missing connection

- LocalTimelineCollection reads TaskTimeline outside a caller transaction, bounds
  events/bytes, and binds canonical content, task ID, source time and collection ID.
- LocalTimelineSnapshotStore keeps one replaceable snapshot per subject, at most
  64 subjects, with expiry at collection start +300000ms. Refresh replaces the ID.
  read checks current hold, exact ID, source bytes, cap and freshness again.
- LocalTimelineRefreshService refreshes explicitly registered subjects. Its counts
  are cycle outcomes, not durable readiness or provider publication receipts.
- PersonalContextEvidenceResolver resolves observation references from
  personal_observations and checks evidence digest, source time and expiry. It
  has no local_timeline_subjects input path.
- MorningRecommendationSource consumes persisted recommendations and contexts.
  MorningBriefPublisher binds their dependencies to the daily publication under
  the daily lease. Adding unbound timeline text to that publisher bypasses this path.
- Configured daily loops still use a null provider refresh reader. Local collection
  cannot satisfy the separate provider activation/refresh receipt contract.

## Chosen implementation direction

Reuse the existing observation/context/recommendation pipeline. Keep collection
outside the daily publication transaction; admit only an exact currently readable
snapshot, then bind its task/source lineage to the persisted observation. Do not
introduce a second daily-report publisher or make a cache row an authority token.

The bridge must be explicit in service configuration and restrict input to already
registered, non-held subjects. It must not auto-register all local tasks. Collection
completion with state=capped, expired/replaced IDs or source changes produces an
unavailable input, never a sufficient context or a successful refresh claim.

## Work units and acceptance before activation

1. Inspect the observation admission and projection-dependency APIs and define the
   durable binding: task ID, exact collection ID, content digest, source update time,
   collection interval, expiry, and subject hold/generation. Use a new migration only
   if existing structures cannot preserve this binding; shipped SQL stays immutable.
2. Implement an admission adapter that rereads the exact snapshot and validates the
   binding in the same transaction as observation admission. Replaying the same
   collection is idempotent. A later collection with identical content must preserve
   its new observation identity without duplicating an actionable recommendation.
3. Extend consumption-side evidence validation through existing projection lineage.
   A subject hold, original task quarantine or source change after admission must
   invalidate affected derived reads; merely checking at collection time is insufficient.
4. Feed admitted observations through existing context and recommendation creation.
   Preserve evidence deadlines: the resulting context must not outlive its evidence.
   Daily publication must still recheck its lease, evidence and byte/action budgets.
5. Run the actual packaged service and daily CLI with an isolated persisted task.
   Prove source -> collection -> observation -> context -> recommendation -> brief IDs,
   restart/replay, hold after admission, replacement before consumption, expiry during
   publication, capped input and missing source. Assert no duplicate actionable output.

## Decisions still required from implementation evidence

The cache deliberately discards previous bytes. Do not retain raw historical
snapshots merely to make an old brief appear current. Determine whether existing
projection dependencies can invalidate a historical observation when the subject
is held or replaced. If they cannot, implement the lifecycle binding before wiring
this bridge into the service. Reports may remain stored historical artifacts, but
current reads must not expose suppressed source content as valid actionable context.

This design does not claim external calendar/mail/messenger input, provider refresh,
production activation, or completion of backlog12/23. The next code task is unit1's
admission/lifecycle inspection, followed by the adapter only when its invariants can
be enforced with the existing transaction and suppression contracts.

## Admission/lifecycle inspection — 2026-09-10

The existing ObservationRefreshStore admission explicitly accepts only normalized
Orca live tasks, with worktree, terminal, session, incarnation, PTY and cursor fields.
A local SQLite task collection does not establish those identities. Do not invent
those fields or label the local cache as an Orca runtime observation to reuse this API.
PersonalObservationStore accepts validated advisory envelopes, but has no local
collection binding/revalidation hook. It is a lower-level persistence primitive,
not a complete adapter for this source.

MemoryProjectionLineage.inherit copies the parents' resolved memory identities;
it checks current parent quarantine during inheritance but does not persist a live
parent-child quarantine relationship. An isolated compiled-Node experiment bound a
synthetic task_timeline parent, inherited an observation child, then quarantined the
parent: parent_suppressed=true, inherited_child_suppressed=false. This is evidence
of the API's existing semantics, not proof that an enabled local-daily bridge leaked
data (there is no such bridge). QA: local-daily-lineage-boundary.json under
/home/jm/.cache/jarvis-test-runtime-qa-20260908.

Next implementation must introduce a durable local observation source binding and
an explicit validator for that binding at derived consumption. The binding needs
the exact subject generation and collection identity alongside source/content/time
fields. Current hold, replacement, missing/changed source and quarantine must reject
consumption even if memory identities inherited earlier remain unsuppressed.
Do not globally change inherit semantics: its existing memory suppression contract
is broader than this adapter and does not represent arbitrary task lifecycle edges.

Before creating the binding, define a local-source observation envelope that states
only persisted local task facts and remains advisory. Add atomic admission and
consumer tests first; then connect context/recommendation production. A new migration
is required if the current immutable persistence cannot hold the binding. This is
JARVIS implementation work, separate from the external provider refresh dependency.

## Read-only local observation draft implemented

`prepareLocalTimelineObservation` rereads an exact ready cache entry and returns a
validated advisory observation using the existing task-timeline/timeline source.
It includes task ID, persisted kind/state/approval flag, source update time and
collection digest/ID; no title, event prose or inferred terminal liveness. IDs are
stable per collection, distinct after replacement. Freshness ends 1ms before cache
expiry to satisfy the existing strict freshness-before-expiry contract, without
extending source lifetime. There is no persistence or service activation yet.

Integration regression passed: stable replay, source identity, unchanged DB bytes,
replacement/held/expiry rejection. Initial equality of freshness and expiry was
rejected by the contract and corrected without changing its validator. Backend
build/lint passed; architecture654modules/2425edges/cycles0. Separate compiled Node
confirmed advisory/read-only behavior and rejection after hold (QA local-observation-live.json).
Durable binding and consumption-time validation remain required before storing or
connecting this draft to daily report production; it is not an admission receipt.

## Persisted draft revalidation implemented

`readCurrentLocalTimelineObservation` reads the canonical observation and digest
in a read transaction, rejects observation quarantine, recreates the exact current
cache draft and requires byte-equivalent canonical material. Replacement, hold and
expiry are therefore checked through the snapshot reader. Callers must keep this
validation inside their consumption transaction. This function is not yet wired
into PersonalContextEvidenceResolver or automatic admission.

Persistence testing exposed that collection IDs are not global ordered checkpoints:
the observation store rejects different checkpoints at an identical observed time.
Local drafts now use checkpoint=null; collection identity remains in evidence_ref
and payload. The existing source checkpoint ordering contract is unchanged.
Two integration tests passed (including multiple same-time persisted drafts,
replacement, observation quarantine and hold); lint and backend build exit0.
Compiled Node persisted/read two same-time drafts and rejected the replaced one
(QA local-observation-read-live.json). No shipped migration was changed.

## Context evidence consumer connected

PersonalContextEvidenceResolver now validates task-timeline:local observations via
readCurrentLocalTimelineObservation before using their stored evidence. This covers
new context admission and the resolver used by morning recommendation validation.
The timeline/cache readers now accept Pick<AuthorityDb, "db">, so the resolver uses
its existing connection without constructing another authority runtime. Error-only
imports point at jarvis-error to preserve an acyclic runtime dependency graph.

Context persistence replay still returns the existing stored metadata; it is not
current evidence consumption. An initial test incorrectly expected replay to run
the resolver; the acceptance now explicitly invokes the consumer after hold.
Related3files/23tests passed; changed-file lint, backend typecheck/build exit0.
Compiled Node resolved one source before hold and rejected it afterward with zero
DB byte changes (QA local-context-live.json). Architecture654modules/2427edges/cycles0.
Automatic local observation admission, assembler source selection and end-to-end
recommendation/brief production remain unfinished. No service activation was added.

## Context assembler selects explicit local task sources

The classifier accepts the exact task-timeline:local source with timeline kind,
Linux control-plane host and local_task_state payload, subject to the existing
verified trust and freshness checks. It does not reinterpret local facts as live
terminal observations. Existing live-adapter selection remains unchanged.

The integration now uses the actual assembler output instead of manually attaching
observation references to a context: draft -> persisted observation -> assembled
context -> persisted context -> held-source rejection during evidence resolution.
The assembler still requires confirmed memory for a sufficient context; local
facts alone remain insufficient. An initial sufficient expectation failed and was
corrected without weakening that rule. Unit7files/22tests and integration1file/3tests
passed, along with changed-file lint and backend build. QA local-context-assembly.log,
local-context-assembly-unit.log and local-context-assembly-build.log record the runs.
The integration runner excludes unit paths, so unit coverage was run separately.
No automatic admission, recommendation generation or service activation was added.

## Atomic explicit observation admission implemented

`admitLocalTimelineObservation` owns an immediate transaction, prepares the exact
current draft, persists through the existing observation store, then revalidates
persisted material before commit. Same-collection replay returns inserted=false;
replacement/hold cannot use replay to bypass current validation. Expiry during the
post-write check rolls back all changes, verified by whole-DB serialized bytes.
No extra table or new migration is required: the existing immutable envelope and
digest carry the collection binding and consumer revalidation checks its source.

Four integration tests passed, changed-file lint and backend build exit0. Separate
compiled Node verified first insert, duplicate replay and rollback after expiry
(QA local-observation-admission-live.json). Automatic repeated admission is not
connected: observation retention/growth and recommendation deduplication still need
an explicit service policy before enabling a recurring producer.

## Explicit CLI admission

`timeline admit-observation TASK_ID COLLECTION_ID --db PATH` invokes atomic admission
for an exact existing collection. Preflight requires an existing database, exact
argument count and a collection ID; irrelevant options are rejected. Output contains
only the observation identity/digest and insertion result. No periodic producer is enabled.

Related2files/6tests and lint/backend build passed. Actual compiled CLI subprocesses
registered/collected a synthetic task, admitted once (exit0/inserted=true), replayed
(exit0/same ID/inserted=false), then held it and rejected admission (exit2,
LOCAL_OBSERVATION_SOURCE_UNAVAILABLE). QA local-admission-cli-live.mjs/.json.
The harness initially parsed error stdout; corrected to inspect stderr as the CLI
contract requires. The isolated database was removed in finally on both attempts.

## Recommendation read projection revalidates local observation sources

The full chain was reproduced in one isolated database before any code change:
`local_timeline_subjects` collection -> admitted observation
(`src:pos:v1:task-timeline:local`) -> persisted context snapshot citing that
observation -> recommendation created through `Recommendations.create` ->
`MorningRecommendationSource` brief item. `tests/integration/local-observation-recommendation-lineage.test.ts`
asserts the identity and deadline bindings of that chain: the observation
`evidence_ref` equals the cached `collection_id`, the context evidence digest
equals the stored observation `canonical_digest`, the recommendation
`context_digest` equals the context canonical digest, its evidence equals the
context evidence, and both its `expires_at` and `freshness.fresh_until` are at or
before the context deadlines. The morning lineage row carries the same
`context_id`, `recommendation_id`, rank, `action_id` and `identity_digest`.

Measured behaviour of the current-read paths after the source was held
(`LocalTimelineSnapshotStore.setHeld`), before the change:

| read path | before hold | after hold (measured) |
|---|---|---|
| `MorningRecommendationSource.generate` | 1 item | throws `MORNING_RECOMMENDATION_SOURCE_INVALID` |
| `projectRecommendations().next_actions` | 1 action | 1 action (stale source still exposed) |
| dashboard `todayProjection().next_actions` | 1 action | 1 action (stale source still exposed) |

The same leak was measured after a replacement collection and after observation
quarantine. `projectRecommendations` was therefore the proven missing consumption
path: it filtered recommendation and action level suppression/quarantine but never
revalidated admitted local material against its current source.

`contextsWithUnavailableLocalSource` now runs inside the existing deferred read
transaction, selects only `personal_context_observations` rows whose observation
`source_id` is `src:pos:v1:task-timeline:local`, and revalidates each through
`readCurrentLocalTimelineObservation` at the projection clock. A `JarvisError`
from that revalidation marks the context; other errors propagate. Actions of a
marked context lose `current`, so they leave `next_actions` and
`owner_decisions_needed`, and a `RECOMMENDATION_SOURCE_UNAVAILABLE` warning with
the action deadline is emitted. Stored history is preserved: those actions remain
in `lifecycle_actions` with their persisted state, digests and transitions.

Policy separation recorded here: persisted context, recommendation and brief rows
stay readable as past artifacts with their stored metadata, while the
current-actionable surfaces (`next_actions`, `owner_decisions_needed`, morning
brief generation) require the local source to still match at read time. Replay of
a stored context or a previously published brief returns stored metadata and is
not a current-evidence check.

Verification. `tests/integration/local-observation-recommendation-lineage.test.ts`
4tests passed. The related integration selection (recommendation, morning, daily,
today paths) ran 39files/411tests, exit0. `runtime:check` exit0, `architecture:check`
654modules/2430edges/0cycles, `build:backend` exit0, changed-file lint exit0.
A separate node process executed only compiled `dist/src` modules against an
isolated database created outside the repository: before the hold the today
projection and the recommendation projection each exposed one current action and
the morning source produced one item; after the hold both projections exposed
none, `lifecycle_actions` still held the stored action, the
`RECOMMENDATION_SOURCE_UNAVAILABLE` warning appeared with deadline
`2026-08-28T12:02:59.999Z`, the morning source raised
`MORNING_RECOMMENDATION_SOURCE_INVALID`, and `total_changes()` was unchanged
across the read paths. The replacement collection produced the same result. QA
`lineage-live.mjs`/`lineage-live.json` in the local evidence directory; the
scratch database was removed in `finally`. The fixtures are synthetic tasks in an
isolated database and are not operational work.

Full gate. `npm run verify` exit0 on this change. Measured: `runtime:check`
`node=v24.19.0 abi=137`; `architecture:check` 654modules/2430edges/0cycles;
backend shard1 271files/1854tests, backend shard2 270files/1887tests, dashboard
38files/263tests, total 579files/4004tests passed; fixed-clock acceptance
`pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`,
`gjc_dispatched=false`; lint, typecheck, build and CLI smoke exit0. Log
`verify.log` in the local evidence directory. This is a development gate, not a
production deployment or an external execution result. Playwright E2E and runtime
package acceptance were not part of this run.

## Morning publication and the published brief read path

The chain above was carried through an actual morning publication under the daily
lease, fence and budgets: `DailyLoopStore.prepare`/`claim` then
`createStoredMorningDailyLoop(...).finish(claim)`, with `refresh_context` and
`morning_reconcile` as the two stored steps. Two fixture facts were required and
are recorded because they are contract, not decoration. Publication rejects a
lineage whose context carries no `memory_projection_dependencies`, so the fixture
binds one confirmed-memory target to the context before the recommendation is
created and the recommendation inherits it. The brief generator abstains when no
item is authoritative, so the fixture action is owner-gated; a non-gated advisory
action publishes a brief with zero items.

Measured after a successful publication (`published=true`, run `completed`, one
`morning_reconcile` step, usage `items=2 work=2`, one `morning_brief`
dependency), before the change:

| read path | after publication | after hold/replacement/quarantine |
|---|---|---|
| `todayProjection().next_actions` | 1 action | 0 actions |
| `todayProjection().brief` | `ready`, `item_count=1` | `ready`, `item_count=1` |

So a published brief kept presenting items whose local source no longer matched
the current source. `latestBrief` already downgraded a brief to `stale` for a
past loop date or for items past `fresh_until`/`valid_until`, but never checked
source availability.

`contextsWithUnavailableLocalSource` moved to `src/local-observation-availability.ts`
and gained `recommendationsWithUnavailableLocalSource`, keyed by the
`contributing_recommendation_ids` a brief item already carries.
`src/dashboard/personal-today.ts` now excludes those items from `currentItems`,
which makes the brief `stale` with `item_count=0` while `brief_id` and
`generated_at` are unchanged. `src/recommendation-projection.ts` consumes the same
module instead of its own copy.

This is the same policy as above, applied one layer later: the published artifact
stays readable as history, and only its claim to be current evidence is withdrawn.

Other measured outcomes, unchanged by this work and now pinned by tests:
publication while the source is already held raises
`MORNING_PUBLICATION_REJECTED`, leaves steps `["completed","pending"]`, the run
`running` with `failure_code=null`, no `morning_brief` dependency and a `no_data`
brief; the same holds when the underlying task row is deleted, and the read
projection then reports `RECOMMENDATION_SOURCE_UNAVAILABLE`. A restart that
reopens the database and runs another `cycle()` returns
`completed_run_ids: []`, keeps one `daily_loop_runs` row and one
`morning_reconcile` step, and returns the identical brief summary, so no
duplicate actionable brief is produced. Publishing after the context deadline
produces an abstaining brief with `item_count=0` rather than expired items.

Verification of this step. `tests/integration/local-observation-morning-publication.test.ts`
8tests passed. A separate node process running only compiled `dist/src` modules
against an isolated database reproduced publication, the post-publication hold and
replacement, and the restart, with `failures: []`, `writes_during_reads: 0`,
`runs_after_restart=1` and `reconcile_after_restart` length 1. QA
`publication-live.mjs`/`publication-live.json`.

Full gate for this step. `npm run verify` exit0. Measured: `runtime:check`
`node=v24.19.0 abi=137`; `architecture:check` 655modules/2433edges/0cycles;
backend shard1 271files/1858tests, backend shard2 271files/1891tests, dashboard
38files/263tests, total 580files/4012tests passed; fixed-clock acceptance
`pre_gjc_ready`, `aggregate_status=stopped`, `completion_promoted=true`,
`gjc_dispatched=false`; lint, typecheck, build and CLI smoke exit0. The dashboard
profile is what covers `src/dashboard/personal-today.ts`; the targeted 40-file
integration selection does not run it. Log `verify2.log` in the local evidence
directory. Development gate only, not a production deployment.

Not covered here. The compiled `jarvis daily morning --once` CLI was not used for
this chain: its schedule window is 07:15 KST while the fixture clock is fixed at
21:00 KST, so driving the CLI needs a time-parameterised chain fixture. A
`capped` local collection was not exercised either, because `LocalTimelineCollection`
caps at 1000 events and 128KiB and the fixture task is small. Both remain open
with those exact resumption conditions.

## Repeated producer growth, duplication and the retention contract

This section is investigation and contract only. No automatic producer, retention
job or service configuration was added.

Measured growth, `tests/integration/local-observation-growth.test.ts`. Eight
registered subjects whose timelines never change, refreshed and admitted for ten
cycles: 80 admissions, 80 inserted, 0 replayed, 80 rows in
`personal_observations`, 80 rows in `personal_context_audit_events`
(`observation_recorded`), and `local_timeline_subjects` still 8 rows with 8
cached snapshots. Database pages grew from 4,292,608 to 4,747,264 bytes, about
5.7KiB per admitted observation. So stored observations and their audit lineage
grow linearly and without bound while the replaceable cache stays at its
registered-subject count; the 64-subject cache cap does not bound storage.

Duplication signals, measured on the same run. Across those 80 rows there are 80
distinct `canonical_digest` and 80 distinct `content_digest`, but only 8 distinct
`payload.value.collection_content_digest` and 1 distinct `payload.value.state`.
Both stored digests embed the collection ID, so they are storage identity, not a
business duplication judgement. The stable business signals are the collected
source bytes (`collection_content_digest`) and the task state. Re-admitting the
same collection replays: `inserted=false`, same `observation_id` and
`canonical_digest`, and no new row. The per-collection identity requirement is
therefore kept as is; duplication must be judged by source bytes and task state
at recommendation time, not by removing that requirement.

Retention cannot be a plain DELETE. Every table in this lineage carries
`immutable_delete` triggers in `migrations/032_personal_context.sql`; the test
measures `DELETE FROM personal_observations` aborting with `immutable personal
observation` and `DELETE FROM personal_context_audit_events` aborting with
`immutable personal context audit`.

The only sanctioned deletion adapter is `buildFreshAuthority`
(`src/memory-authority-fresh-builder.ts`): it migrates a fresh database, drops
triggers and sets `foreign_keys=OFF` for the copy, applies per-table `copyFilter`
predicates keyed on a temporary `blocked_projections` table, runs
`removeSuppressedRows`, recreates every trigger, restores `foreign_keys=ON`, and
then requires an empty `foreign_key_check` and `integrity_check=ok` before
retiring the active generation and activating generation+1. It also scans the
resulting bytes for suppressed content.

Reference contract, measured. `copyFilter` drops `personal_context_*` rows only
when the **context** is blocked, never when an observation is blocked. Blocking a
single observation that a surviving context cites therefore leaves a dangling
`personal_context_observations` row and the rebuild is refused with
`MEMORY_COMPACTION_FOREIGN_KEY_INVALID`, with the source database unchanged.
Blocking the observation together with its citing context and that context's
recommendation succeeds: `foreign_key_errors=0`, `integrity_check=ok`,
`result_generation=source_generation+1`, and the rebuilt database holds zero
observations, zero context observation links and zero recommendations.

Deletion lineage is preserved by construction: `personal_context_audit_events` is
explicitly excluded from the context copy filter, and the rebuilt database keeps
the same audit row count after its subjects are removed. The replaceable local
cache never crosses reconstruction: `copyExpression` nulls
`local_timeline_subjects.snapshot_json`, `collection_id` and `expires_at` while
preserving the subject row and its hold, measured as 1 subject row with 0 cached
snapshots after the rebuild.

Notification references, and a limit on the guard above. The investigation list
also names notifications, and they do not behave like the other three.
`notification_intents` in `migrations/033_personal_operations.sql` holds no
foreign key into the personal lineage; it carries `correlation_id` and a free-text
`deep_link`, and `src/notification-intent-types.ts` passes `recommendation_id`
into the intent by value. Across every migration other than `032`, only two
foreign keys point into `personal_*` at all: the `replacement_recommendation_id`
self-reference added by `034`, and a `personal_context_reference_sessions`
reference in `071`. `notification_deliveries` references only its intent.

The linkage is weaker still than "by value". `src/notification-intent-store.ts`
inserts exactly `intent_id`, `correlation_id`, `idempotency_key`, `dedup_key`,
`urgency`, `channel`, `redacted_preview`, `deep_link`, `state`, `expires_at`,
`created_at` and `updated_at`. No recommendation column is persisted at all: the
recommendation survives only inside the opaque `deep_link` text and inside
`dedup_key`, which `src/decision-queue.ts` derives from a hash over
`recommendation_id` and `action_id`. A cutoff therefore cannot locate the affected
intents by any indexed column; it would have to parse deep links or recompute
those hashes.

The consequence is that the protection measured above is narrower than it looks,
and it is now measured rather than inferred. With an intent addressing a
recommendation, a rebuild blocking that recommendation together with its context
and observation returns `foreign_key_errors=0` and `integrity_check=ok`, the
recommendation row is gone, and the intent survives with its `deep_link`
unchanged and still addressing the removed recommendation. The same test also
fixes a trap: searching `deep_link` for the raw recommendation ID matches nothing,
because the ID is percent-encoded inside the link, and only the encoded form
matches. A cutoff must encode before it can even find what it broke. `foreign_key_check=0` is therefore evidence about the constrained
tables only, and must not be read as a completeness signal for the cutoff as a
whole. Any cutoff design has to decide notification handling explicitly, because
the database will not decide it.

Contract that follows from those measurements. A retention cutoff must be
expressed as an additional blocked-projection set fed to the same rebuild
adapter, not as a new deletion path. A cutoff may only remove an observation
whose citing contexts, and those contexts' recommendations, are removed in the
same set; otherwise it must retain the observation. Audit rows are never part of
a cutoff set. Because notifications carry recommendation references by value and
not by constraint, a cutoff that removes recommendations must also resolve the
notification intents addressing them, and that resolution has to be selected and
checked by the cutoff itself; the rebuild's foreign key check will not catch it. `observation-refresh-compaction.test.ts` already fixes the read
behaviour after such a removal: the historical receipt stays readable and its
current read reports `unavailable`/`source_missing`, which is the same policy the
sections above apply to contexts, recommendations and briefs.

Restart, same instant and duplicate service start, measured. One
`LocalTimelineRefreshService.cycle()` over eight subjects reports
`attempted=8, collected=8, failed=0, held=0` and writes cache rows only:
`personal_observations` and `personal_context_audit_events` both stay at 0, so
the collection service by itself never grows storage and admission remains
explicit. Calling `cycle()` again on the same instance at the same clock returns
`undefined`.

That 60,000ms throttle is in-memory instance state (`nextAt`), not a durable
lease. A restarted instance and a duplicate concurrent instance both start at
`nextAt=0` and collect again at the same clock: three starts at one instant
produced three complete generations of collection IDs with zero overlap between
consecutive generations, while `local_timeline_subjects` stayed at eight rows.
Admitting once per start therefore stores one immutable observation per start for
byte-identical source content, and the measurement confirms eight rows with eight
distinct `collection_content_digest` values, one per subject. So duplicate or
restarted producers multiply stored observations without changing the underlying
facts, and any future automatic admission needs a durable cycle fence rather than
this per-instance throttle.

Duplicate actionable output, measured, and the defect it exposed. Three producer
cycles over one unchanged task were driven end to end: each cycle admits its own
observation and builds its own context and recommendation, so storage reaches
3 observations, 3 contexts and 3 recommendations while
`collection_content_digest` stays at one distinct value. Before the change the
actionable reads were already correct - `next_actions` and the dashboard
`next_actions` each held exactly the newest recommendation, with one
`RECOMMENDATION_SOURCE_UNAVAILABLE` warning per superseded producer - but
`MorningRecommendationSource.generate` raised
`MORNING_RECOMMENDATION_SOURCE_INVALID` from the second cycle onward. A repeated
producer therefore did not duplicate output; it removed the morning brief
entirely, permanently, which is a hard blocker for automatic admission rather
than the documented soft limitation.

`MorningRecommendationSource` now excludes a candidate whose cited context has an
unavailable local source, counting it in a new `excluded.source_unavailable`
field, exactly as it already excludes suppressed and quarantined candidates in
SQL before parsing. Measured after the change, per cycle n: storage n, one
distinct source digest, `next_actions` exactly the newest recommendation,
`lifecycle_actions` n, n-1 `RECOMMENDATION_SOURCE_UNAVAILABLE` warnings, dashboard
`next_actions` 1, `excluded.source_unavailable` n-1, brief items 1,
`needs_you_first` 1 with a single contributing recommendation ID. Duplicate
actionable recommendations and duplicate brief items are therefore 0 across
repeated producers, which is the A.5 and B requirement.

The exclusion is narrow. Quarantining the newest observation excludes every
candidate and the brief abstains with `no_authoritative_data` rather than
publishing a partial result, and an altered context envelope still raises
`MorningRecommendationSourceError`, so integrity failures remain fail-closed and
only supersession, hold, replacement and quarantine of a local source became
exclusions.

Publication behaviour changed with it, deliberately, and the earlier assertions in
`local-observation-morning-publication.test.ts` and
`local-observation-recommendation-lineage.test.ts` were rewritten to the new
contract rather than kept. Previously a held or missing local source made
`MorningBriefPublisher` raise `MORNING_PUBLICATION_REJECTED`, leaving the run
`running` with steps `["completed","pending"]` and no brief at all. Measured now,
identically for a held source and for a deleted task row: `finish` returns true,
the run is `completed` with `failure_code` null, both steps are `completed`, and
the published brief is `state=degraded` with `item_count=0`,
`context_readiness=degraded`, `abstention_reasons=["no_authoritative_data"]`,
`needs_you_first=[]`, no `morning_brief` projection dependency, and no withdrawn
content anywhere in the stored step detail. The daily run therefore completes with
an honest degraded abstention instead of wedging the morning step, and it still
never emits partial or stale material. That trade is required by B: under a
repeating producer the previous behaviour would refuse publication every time the
last remaining producer had just been superseded, which is the same outage in a
narrower form.

Full gate for the exclusion change. `npm run verify` exit0. Measured:
`architecture:check` 655modules/2434edges/0cycles; backend shard1
272files/1861tests, backend shard2 272files/1899tests, dashboard 38files/263tests,
total 582files/4023tests passed; fixed-clock acceptance `pre_gjc_ready`,
`aggregate_status=stopped`, `completion_promoted=true`, `gjc_dispatched=false`;
runtime check, lint, typecheck, build and CLI smoke exit0. Log `verify3.log` in
the local evidence directory. Development gate only, not a production deployment.

Cutoff boundary, measured. Three observations were admitted on one task at
60,000ms clock steps, giving three distinct `expires_at` values in ascending
order. A cutoff placed exactly on the second observation's expiry, selected with
`expires_at<=?`, matched the first two, so the boundary is inclusive and the
observation sitting exactly on the cutoff is removed. Feeding that selection to
`buildFreshAuthority` as blocked observation projections rebuilt with
`foreign_key_errors=0`, `integrity_check=ok` and `result_generation` one above
the source, leaving exactly the single observation past the cutoff.

Two properties of that rebuild are worth stating because they are easy to assume
wrongly. Audit lineage is untouched: all three `observation_recorded` rows and the
total audit count survive the removal of their subjects. And retention is a row
contract, not a size promise - the rebuilt database measured 4,354,048 bytes
against the source's 4,304,896, because a freshly migrated database carries its
own baseline schema and a new generation row. At this scale a cutoff reduces rows
while the file grows, so no retention design should be justified by expected file
shrinkage.

## Durable collection cycle fence

The measurements above named a durable cycle fence as a prerequisite for any
automatic admission, because the 60,000ms throttle lived in process memory and a
restart or duplicate start collected again at the same instant.
`migrations/088_local_timeline_cycle_fence.sql` adds a single-row fence and
`LocalTimelineRefreshService.cycle()` now claims the window in one immediate
transaction instead of consulting an instance field. The claim reuses the
caller's instant and performs no additional clock read, which the existing
service tests require because their fake-clock arrays are calibrated to the exact
number of `clock()` calls.

Measured after the change: a fresh instance standing in for a restart and a
duplicate concurrent instance are both refused at the same clock, cached
collections are unchanged and `total_changes()` is unmoved by the refused
attempts. The fence row records `claimed_at` and the `next_at` it advanced to.
Past the window a start collects again, which is the intended cadence rather than
a bypass, and collection still admits nothing by itself. `npm run verify` exit0
on this change: backend shard1 272files/1862tests, backend shard2
272files/1899tests, dashboard 38files/263tests, total 582files/4024tests,
architecture 655modules/2434edges/0cycles, fixed-clock acceptance
`pre_gjc_ready`/`stopped`/`completion_promoted=true`/`gjc_dispatched=false`. Log
`verify4.log`.

Content-based admission dedup was considered and rejected rather than deferred.
An observation's identity binds its collection, and consumption revalidates
against the current cached collection, so reusing an earlier observation for
unchanged content would produce a row that is permanently unavailable as soon as
the cache is replaced - the behaviour the replacement tests already measure. It
would also contradict the instruction not to remove the per-collection identity
requirement in order to hide duplication.

## Retention cutoff selection

`src/local-observation-retention.ts` implements `selectLocalObservationRetention`,
which turns a cutoff instant into the set a rebuild could remove. It is read-only:
it performs no deletion and opens no write, and the test asserts `total_changes()`
is unmoved across a selection. Applying the result stays a separate step through
`buildFreshAuthority`, which remains the only sanctioned deletion path.

The function encodes the four measured constraints rather than restating them.
The cutoff matches `expires_at<=cutoff`, so the observation sitting exactly on it
is selected. A cited observation expands to its citing context and that context's
recommendations, which is exactly the grouping the rebuild accepts: feeding a
selection straight into `buildFreshAuthority` returns `foreign_key_errors=0` and
`integrity_check=ok` and empties the observation and recommendation tables.

Two cases are retained instead of selected, each with a recorded reason.
`notification_addresses_recommendation` holds an observation whose recommendation
a notification intent still addresses, matched on the percent-encoded ID because
the raw form matches nothing. `context_cites_current_observation` holds one whose
context also cites an observation still inside the window, since removing that
context would drop links to material the cutoff did not select.

One limit of the selection is identified but not yet measured, and it is recorded
here so it is not mistaken for covered ground. `migrations/034` adds
`replacement_recommendation_id` to `personal_recommendation_action_events`
referencing `personal_recommendations`. The rebuild filters those event rows by
their own `recommendation_id`, not by the replacement target, so a selection that
blocks a newer recommendation while keeping an older one whose event names it as
the replacement would leave a dangling foreign key and the rebuild would refuse
the whole set with `MEMORY_COMPACTION_FOREIGN_KEY_INVALID`. A time-ordered cutoff
usually removes the older material first, which is the safe direction, but the
selection is driven by observation expiry rather than recommendation age, so the
unsafe ordering is reachable. The next unit should measure this case and either
expand the selection to the naming events or retain the group, matching how the
two existing retain reasons behave.

The retain-on-notification rule deserves a note, because it is a choice and not a
measurement. Declining to delete is the conservative reading, and it is the only
option that changes nothing a user can see. Whether a cutoff should instead remove
or suppress those intents is a user-facing data decision that is deliberately not
made here; the selection surface simply refuses to break them, which is what the
absent foreign key would have done had one existed.

Gate for the selection surface. `npm run verify` exit0: backend shard1
273files/1868tests, backend shard2 272files/1899tests, dashboard 38files/263tests,
total 583files/4030tests, architecture 656modules/2436edges/0cycles, fixed-clock
acceptance `pre_gjc_ready`/`stopped`/`completion_promoted=true`/
`gjc_dispatched=false`. Log `verify5.log`.

Not yet done in B. Applying a selection on a schedule, and the configuration
surface that would choose a cutoff, are not implemented; no opt-in service wiring
exists, which is correct because the handoff requires the contract and its
verification first. The measurements above also show what that wiring will need:
a durable cycle fence, and a duplication judgement over
`collection_content_digest` and task state so repeated cycles stop creating
storage that only the read paths discard.

Limits. The morning source still fails the whole read when one cited local source
is unavailable instead of excluding that recommendation; that fail-closed
behaviour was left unchanged. Contexts produced by `assemblePersonalContext`
still cannot back any recommendation, because the assembler emits
`context_observation` and `confirmed_memory` evidence kinds while
`recommendation-evidence-binding.ts` citation slots require `linux_live_fact`,
`user_confirmed_principle` or `owner_decision`; the lineage test pins that
measured boundary. No producer in `src/` assembles or persists a context, so the
chain above is exercised through the library and stored fixtures, not through a
scheduled service.
