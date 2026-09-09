# Provider refresh composition: inspected boundary and next implementation

Inspected source: ece7210. This is a design decision for backlog12/23, not a
completed connector or operational activation.

## Current execution boundary

- `cli-daily-commands.ts` constructs the morning loop with an empty event drain
  and a refresh reader returning null. It reports provider_refresh unavailable.
- `cli-evening-inputs.ts` supplies those same readers to the configuration consumed
  by `DailyServiceCycles.fromFiles`.
- `daily-loop-morning-execution.ts` calls refresh_reader.read inside an immediate
  SQLite transaction and completes the refresh step in that transaction.
- `RefreshCompletion` carries schema version, refresh ID, completion state/time,
  protocol version and capped. It does not identify source rows, their digests,
  projects or accepted observation IDs.
- `evaluateRefreshContext` evaluates this record's shape, state and freshness;
  it does not prove that a provider ran or that observations were persisted.
- `createPersonalConnectorRegistry` has a definition and export in src, but no
  service call site found by symbol search. Its inspect path returns snapshots;
  it does not provide a durable daily refresh receipt.
- Calendar, mail and messenger definitions currently set configured=false.
- `personal-observations.ts:247` exports normalizeAndPersistPersonalObservations,
  wrapping normalizePersonalObservations and store.persistObservation. Reuse its
  input validation; wrap admission atomically at the owner boundary instead of
  introducing a new raw-observation storage path.

## Decision

Do not put provider/network I/O inside the synchronous refresh reader or its SQLite
transaction. Do not accept an operator-supplied completed JSON record as evidence
that current provider data was ingested. Neither change completes backlog12/23.

Implement collection outside the transaction, followed by a bounded atomic
admission operation. The admission must bind a configured source/project scope,
source identities and observation digests, observation IDs, checked/completed times,
protocol version, cap status and an idempotency key. Only after the observations
and receipt commit together may a database reader expose completion to the daily
loop. Replays must return the same receipt and not duplicate observations. A changed
payload under the same key must fail. Source failure and empty successful collection
must remain distinct. Source/project scope must be checked again when reading a
receipt; a recent refresh for another scope cannot satisfy the configured loop.

The first collector should reuse an existing structured source (Orca/task timeline)
and preserve its provenance and size limits. A mail/calendar integration remains
unimplemented until its actual provider contract and credentials are configured.
Second Brain work remains in its own workspace; Jarvis consumes only a verified
contract and must not promote retrieved memory into owner approval.

## Required acceptance before enabling

1. A real collector process obtains structured input and persists observations plus
   receipt; another process can reopen and read the same committed evidence.
2. Two processes with the same key produce one receipt and one observation set.
3. A failure between observation writes and receipt settlement rolls both back.
4. A provider timeout performs no admission; it does not block the service's SQLite
   transaction. Explicit output and time budgets stop collection.
5. A stale, future, capped, failed, wrong-scope or incomplete receipt cannot produce
   ready. Empty success is reported explicitly without fabricated observations.
6. Deletion/quarantine of source observations invalidates their refresh evidence;
   suppression checks and lineage use existing authority mechanisms.
7. Actual service restart and daily recovery use the committed receipt without
   recollecting or double-publishing an already completed daily phase.

These are implementation requirements, not passing-test claims. The remote-audit
service verification currently running is independent of this source-refresh gap.
