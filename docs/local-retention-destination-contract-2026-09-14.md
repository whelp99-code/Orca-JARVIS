# Local retention destination contract

What the retention operation does with the destination it was given, and which of the two possible
answers was chosen where the specification left a choice.

## The destination is announced, not created

A run builds everything it writes under a staged name of its own - derived from the destination and
the run's own operation id - and the destination itself is only ever brought into being by the
publish rename. Nothing creates it beforehand, so there is no window in which a directory sits at
that name without an operation that can prove it owns it.

That is why "a file somebody else left at the destination is preserved" holds without any code to
preserve it: the path is not touched at all until the rename, and the rename cannot land on a name
that is already taken.

## A name already taken is refused, not worked around

Where the specification allowed either refusing the operation or building under a quarantine name,
the product **refuses**, with `LOCAL_RETENTION_DESTINATION_INVALID`, before anything is written down.

Refusing is the honest answer because the caller named a destination and the operator will look for
the result there. Quietly writing somewhere else would leave them with a successful-looking run and
an artifact at a path they were never told, and it would make "the destination is free" something
the product decided rather than something it observed.

The refusal is taken in `resolveRetentionDirectory` (`src/local-observation-retention-claim.ts`),
which resolves the real parent, refuses every spelling of the source itself, and refuses any name
that already exists in any form. The directory create that follows is still what decides ownership;
the check only stops a run announcing a path it cannot have.

## What is pinned, and that the pin has teeth

`tests/integration/local-observation-retention-destination.test.ts` covers the destination in each
form something else can already hold it:

- a file, preserved byte for byte;
- an occupied database file, likewise;
- a non-empty directory, left exactly as it was;
- an empty directory, refused and left standing - the case that would be lost first by any
  implementation that replaced rather than refused;
- every spelling of the source itself, including a relative path and a symlink;
- a stale `-wal` sidecar beside the name, untouched, with nothing written through it;
- two racing calls, exactly one of which wins.

The tests read `applied.operation.candidate_path` from the ledger rather than predicting where the
run will build, which is what lets the staged name carry an operation id at all.

Measured on 2026-09-14:

- whole retention suite: 13 files, 128 tests, rc 0;
- mutation check: removing the existence guard from `resolveRetentionDirectory` fails 4 of the 6
  destination cases, and restoring it passes all 6 - so the pin discriminates rather than passing
  by construction.
