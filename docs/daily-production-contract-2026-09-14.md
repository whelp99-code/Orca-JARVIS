# Daily production contract

What has to be true before the morning run proposes anything, in the order the producer asks, and
what happens when each is missing. Written because the ranking engine refuses some inputs outright:
an empty candidate list and an empty principle list are both refusals at its input boundary, so a
run that has nothing to propose must say so before it gets there rather than fail.

`src/personal-daily-production.ts` (`produceStoredDailyRecommendation`):

| Condition | When it does not hold |
| --- | --- |
| A memory reference was read from a provider | `withheld: no_memory_reference`, nothing written |
| The reference seam returned at least one evidence memory | `withheld: no_confirmed_principle` |
| The owner's decision admitting that principle is on record | `withheld: no_owner_import_decision` |
| At least one stored observation is still current | `withheld: no_current_observation` |
| At least one observation can be cited as a current Linux fact | `withheld: no_citable_current_fact` |
| The owner authorized a workflow for that fact's subject | `withheld: no_owner_workflow_authorization` |

Each withholding returns before `produceDailyRecommendation` is called, so no context is assembled
or stored for a run with nothing to propose.

`src/personal-context-production.ts` (`produceDailyRecommendation`) then:

- leaves out any memory whose originating task the owner has closed, at intake, before the context
  is assembled or persisted;
- cites a `user_confirmed_principle` only where this database holds the owner's confirmation for
  that content, and a `linux_live_fact` only where a collection receipt names that observation with
  the digest it still has;
- selects an action only where the gate it would cross is an approved, unrevoked, owner-signed
  decision that is current and names the subject the action's evidence is about.
  `policyFacts` cites gate references through `approvedOwnerDecisionDigest` without the
  `{ action, subject }` binding `ownerGateDecided` passes; selection still goes through
  `ownerGateDecided`, so that unbound citation cannot change which action is selected.

## Which surfaces produce

Both morning surfaces produce, and both derive the policy the same way, from
`src/daily-production-policy.ts`: the shipped `config/personal-os-policy.json`, the decision
reference built from its `policy_id`, and the provider read this deployment names through
`JARVIS_SECOND_BRAIN_LAUNCHER` / `JARVIS_SECOND_BRAIN_CONFIG`.

- `daily morning --once` (`src/cli-daily-commands.ts`) reads the policy once for the run it is
  about to make and hands the result to `createStoredMorningDailyLoop`.
- the configured service, `service once` and `service run` (`src/daily-service-cycles.ts`), hands
  over the question instead of the answer and re-derives it before each morning phase. A service
  that has been up for a week must not produce against the provider read it made the day it
  started. The read stays in the async cycle; the step is still one synchronous transaction.

A deployment that names no provider produces nothing on either surface and still publishes what is
already on record - that is an abstention, not a failure, and it does not stop the evening phase.
`tests/integration/daily-service-cycles.test.ts` pins both service outcomes (one produced row, and
zero rows with no provider) through the compiled build in its own process.

## Minimum facts

`context_policy_input.evidence` may legitimately be empty - `src/context-policy-input.ts` accepts an
empty list - and the policy then abstains rather than failing. The engine's hard minimums are
therefore only these two, and they are the producer's responsibility to satisfy or avoid:

- `principles`: at least one entry, evidence or gap;
- `candidates`: at least one entry.

`tests/unit/daily-production-contract.test.ts` pins both boundaries.

## Which current-validity conditions are production inputs

§7.2.3 and §7.2.5 name hold, quarantine, expiry, snapshot missing, real source missing, replacement
and capped collection. On the production path they do not all mean the same thing, because the local
task-timeline collection is an advisory source: §7.1.2 keeps it out of `linux_live_fact`, so
`produceStoredDailyRecommendation` filters the citable set down to live facts and the local
collection can never be the one an action's `current_evidence_ref` points at.

So a condition on the local collection is not a condition on a production input. With a provider
present, an authorized workflow and a confirmed memory on record, a held, cleared, deleted, replaced
or capped local collection leaves the run **producing** from the live observation beside it. The
local observation is dropped from `currentObservations` - it is genuinely no longer current, and
`tests/integration/daily-morning-production-validity.test.ts` asserts that before each run - but the
run still has a fact to cite. That is correct, not a gap: promoting the local collection to a
production input is exactly the renaming §7.1.2 forbids.

The conditions that do withhold, before any context is assembled or stored:

| Condition on a production input | Outcome |
| --- | --- |
| Every stored observation past its own window | `withheld: no_current_observation`, 0 contexts, 0 recommendations |
| The cited observation's projection quarantined or suppressed | `withheld: no_current_observation`, 0 contexts, 0 recommendations |
| The memory candidate behind the principle quarantined | `withheld: no_confirmed_principle`, 0 contexts, 0 recommendations |
| The task that memory was derived from closed by the owner | `withheld: no_confirmed_principle`, 0 contexts, 0 recommendations |

`currentObservations` asks the projection authority about every stored observation, whatever its
source. The collection seams already refuse a suppressed observation when they are the ones being
read, but the producer reads `personal_observations` directly and reaches none of them - without
that question a quarantined observation could still be cited as a current Linux fact and published.

The collection receipt is the one source that cannot go missing: it is the immutable manifest
`collectedObservation` reads, and the product refuses to delete it
(`OBSERVATION_REFRESH_IMMUTABLE`). A cleared local snapshot at an instant where the observations are
still current is likewise unreachable without writing to the store's own table, so that case is
pinned at the instant where both hold.

## Fixtures: which ones the production acceptance may rest on

Two fixtures declare evidence kinds and insert a recommendation row directly, and both are marked at
the top of the file as **engine / read-surface fixtures**:

- `tests/fixtures/local-observation-chain.ts` - hand-built `linux_live_fact`,
  `user_confirmed_principle` and `owner_decision` policy facts, declared context evidence `kind`s,
  and `new Recommendations(db).create(...)` with declared `linux_evidence` kinds;
- `tests/fixtures/recommendation-fixture.ts` - declared `context_observation` / `confirmed_memory`
  context evidence, consumed by roughly twenty recommendation and brief suites.

They are the right input for the consumption side. A brief reader, the recommendation read
semantics, the evidence-binding and lifecycle surfaces and the daily loop's publish-only path all
need a recommendation on record to read, and no provider is involved in reading one. What they
cannot do is stand as evidence that the producer works: a row a fixture inserted says nothing about
`produceStoredDailyRecommendation`, and a declared `linux_live_fact` says nothing about the citation
contract that decides what may be cited as one.

So the §7.3 process-level production acceptance uses neither. It rests on
`tests/fixtures/daily-production-chain.ts`, which inserts no recommendation and no context - it
asserts both tables are empty before the run - and every case binds an assertion to the
recommendation id the run itself produced:

| §7.3 case | Where | Binds to |
| --- | --- | --- |
| normal path | `daily-morning-production.test.ts` | produced id in the published brief detail |
| same-instant rerun / other-process restart | `daily-morning-production.test.ts` | same produced id, one reconcile, same `brief_id` |
| two competing services | `daily-service-cycles.test.ts` | one produced id, one reconcile |
| configured service, provider present / absent | `daily-service-cycles.test.ts` | produced id / zero rows |
| hold, quarantine, expiry, snapshot missing, source missing, replacement, capped | `daily-morning-production-validity.test.ts` | produced id, or zero rows and zero contexts |

`tests/integration/daily-morning-cli-process.test.ts` stays as the publish-only process regression -
the reader side, the two-step run contract, the fail-closed configuration path and the exclusions
the brief applies to a recommendation already on record. Its header says so.

## The packaged probe, and what stands in for it inside `verify`

`scripts/packaged-production-chain-probe.mjs` cannot be part of `npm run verify`, and this is not a
policy choice. Its first argument is a `PACKAGE_ROOT`: it reads
`<root>/runtime-package-receipt.json` and imports every product module from `<root>/dist/src`, so
nothing resolves into the development checkout. That root is produced by
`npm run product:package-electron`, which runs `product:install-electron` and downloads and installs
an Electron runtime. `verify` runs on a tree that has only been built, has no package root, and must
not acquire a network install step - so the probe has no argument to be given. It is reachable by
name instead:

    npm run probe:packaged-production -- <PACKAGE_ROOT> [RECEIPT_PATH]

The four branches it asserts - produced 1 row / unauthorized 0 / unconfirmed 0 / providerless 0,
each through a real child process against a real stdio provider - are pinned inside `verify` by
`tests/integration/daily-morning-production.test.ts`, whose five cases are the same four plus the
same-morning rerun. That file runs the compiled `dist/src/cli.js` module graph in its own process
through `tests/fixtures/compiled-daily-cli.ts`, and `verify` reaches it through `npm test` ->
`node scripts/run-tests.mjs backend`, whose glob is `tests/**/*.test.ts`.

What the in-repo regression does not cover, and the probe therefore still earns: that the *packaged*
module graph - the one a user runs - resolves `better-sqlite3` and the product modules from the
package rather than from the checkout. That is a packaging property, not a production-chain
property, and `round2-probe.json` is where it is recorded.

## Closure, and what it reaches

A memory is closed when the owner hides the task it was derived from, or takes that
task's project out of scope. Two notes on how that is answered, recorded here
because both are deliberate and neither is obvious from the call sites:

- The join is by content digest: `personal_context_memory_evidence.evidence_digest`
  against `memory_candidates.content_digest`. The only product path that writes that
  digest is the reference seam, and the daily producer is its caller, so a memory
  carried into a context by the product can always be reached by a later closure. A
  caller that invented its own digest would write a row nothing can close - which is
  why production now takes its memories from the seam rather than from its request.
- `contextsWithClosedMemorySource` withdraws a recommendation when any memory bound
  to its context is closed, not only the one an action cited. That is deliberate and
  fail-closed: the alternative is deciding, after the fact, that a closed memory did
  not really matter to work already proposed.
