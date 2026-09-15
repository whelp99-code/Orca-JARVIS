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
