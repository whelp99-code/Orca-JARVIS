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
