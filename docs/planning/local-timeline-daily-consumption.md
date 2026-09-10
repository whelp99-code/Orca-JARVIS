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
