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
