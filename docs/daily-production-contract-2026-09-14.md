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
