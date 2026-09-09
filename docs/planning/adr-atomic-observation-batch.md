# Atomic normalized observation batches

AuthorityDb.persistObservationBatch persists at most256 canonical observations in
one immediate transaction using the existing per-observation validation, checkpoint
and audit paths. normalizeAndPersistPersonalObservations selects this method when
the store supplies it. Existing custom stores with only persistObservation retain
their previous per-row behavior and do not acquire an atomicity guarantee.

The empty batch validates the timestamp and returns an empty list. It is not a
provider refresh receipt. A malformed row, conflicting replay or SQL failure rolls
back the entire batch; a caller's outer transaction can also roll it back after the
batch returns. This permits a future refresh owner to commit observations and its
receipt together. No schema change, source collector, scheduler activation or
refresh-completion record is introduced in this unit.

## Evidence

- Integration/reviewability3files6tests, observation unit3files15tests passed.
- Typecheck, lint and full build exit0. This change postdates the3905-test canonical
  gate and does not claim that gate for the new code.
- Compiled file DB, injected second-insert failure: before1 observation/checkpoint;
  after0/0 both with and without an additional outer transaction. FK violations0.
- Three compiled processes: failure inserted0/stored0; retry inserted4/stored4;
  replay inserted0/stored4. Checkpoints0/4/4; each process FK violations0.
- Evidence under /home/jm/.cache/jarvis-test-runtime-qa-20260908:
  observation-batch-atomicity.json, observation-batch-atomicity-after.json,
  observation-batch-restart.json and matching .mjs harnesses.

Full provider refresh admission, source/project scope, durable receipt identity and
suppression-aware reading remain required by adr-provider-refresh-composition.md.
