# Generic command list pagination boundary

Inspected product baseline: a951729. This is remaining backlog16 work, not an
implemented API. Work-lineage acceptance is under independent review.

## Observed call path

`executeControlCommand` handles `control list` by calling `ControlPlane.list()`,
which calls `listControlCommands`. The latter loads every command and builds an
in-memory predecessor map. A repository search found no other explicit
`control.list()` caller in src/dashboard, but the exported library method remains
an external compatibility surface. A text search cannot prove external non-use.

Dashboard pagination is not directly reusable: its index and membership include
only pending/approved/failed requests, while the CLI lists all command states.
Its response also omits command arguments that the generic command API returns.

## Required implementation and verification

1. Define a bounded CLI default and explicit continuation metadata; never truncate
   the current requests array silently. Preserve explicit full-export compatibility
   separately and document its memory cost. Keep the public list API contract until
   an explicit replacement/migration path exists.
2. Use a general requested_at/request_id seek index, not the partial actionable
   index. Keep ordering deterministic for equal timestamps and long identifiers.
3. Bound scanned rows as well as returned rows. A page consisting entirely of
   suppressed rows must still make forward progress with a valid continuation.
   Do not load all ancestors into RAM to produce a small page.
4. Apply current common visibility, including own task and ancestor suppression,
   within one read transaction. Cursor reuse must not cache permission or reveal
   hidden payloads. Define behavior when an anchor is removed/replaced.
5. Bound predecessor lookup/cache within each page and preserve the accepted
   maximum depth. A count of SQL prepare calls is not SQLite operation complexity.
6. Validate two compiled CLI invocations with persisted DB state and continuation;
   cover equal timestamps, hidden spans, late quarantine, all states and invalid
   cursor inputs. Reads must preserve DB bytes.
7. Measure 10k/100k populations with task.execute lineage and unrelated quarantine
   records as well as generic commands: p95 sample count, response bytes, scanned
   rows, query plans and memory. Record concurrent load and fixture limitations.

Do not declare backlog16 complete from projection_id indexes alone. Other overview
and command consumers require their existing evidence to be reconciled separately.
