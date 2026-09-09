# Scoped observation refresh admission evidence

This unit is a local persistence foundation. ObservationRefreshStore accepts only
normalized structured Orca tasks within configured source IDs and worktree IDs.
It does not authenticate a provider, execute network calls, or activate daily service.
Portfolio, mail, calendar and Second Brain collection are not admitted by this API.

The immutable receipt binds a hashed request key, hashed scope, checked/completed
times, cap flag and ordered observation IDs/canonical digests. Receipt and the bounded
observation batch commit in one SQLite transaction. Failure at receipt insertion
rolls back observation, checkpoint and audit writes. Exact retries reuse the original
receipt, including after expiry; replay does not make expired data current. Changing
the same request's content is rejected.

Read is scoped and transactional. It revalidates stored observation bytes and checks
source presence, freshness, expiry and projection suppression/quarantine. Missing or
unavailable evidence cannot report ready. A successful empty admission reports no_data;
a capped admission reports unavailable. Readiness means recorded local sources are
currently valid, not that a provider was authenticated or an entire workspace scanned.

Migration084 stores only minimal metadata. There is deliberately no FK to the source
observation table: source erasure must not be blocked by a historical refresh record.
The reader treats absent observations as unavailable. IDs/digests and hashed request
keys remain linkable local history, not anonymized data. Automatic retention and
compaction of this receipt metadata are not implemented. Production activation is
held pending that lifecycle decision and the real collector contract.

The existing normalizer binds observation identity to checkpoint while its canonical
envelope includes checked_at. Re-admitting an unchanged checkpoint with a changed
envelope must continue to fail existing digest checks. The future collector must
resolve this identity/freshness contract instead of relabeling old data as refreshed.

## Current validation

- Focused receipt/batch/reviewability3files10tests passed.
- Typecheck, lint and build exit0; build contains91 migrations.
- Two compiled processes on a temporary file DB: first inserted=true, restart=false;
  same refresh ID, observations2, receipts1, FK0. Reads changed0 serialized DB bytes.
- Receipt insertion failure rolled back the entire DB to identical serialized bytes.
- Cross-worktree admission denied before writes; cross-scope read returns null.
- Source quarantine, capped admission, expiry and future replay covered.
- Receipt evidence:
  /home/jm/.cache/jarvis-test-runtime-qa-20260908/observation-refresh-restart.json
  and matching .mjs harness. Fixtures were removed after verification.

The earlier3905-test gate predates this unit. No full-gate or operational completion
claim is made for this new schema/API. Backlog12/23 and the full01–25 remain open.

## Scope review correction

Independent review reproduced a missing-coverage defect:2 configured sources and
worktrees with only1 submitted observation could report ready. Admission now requires
explicit collection outcomes covering every configured source and worktree, binds
these outcomes in the manifest, and accepts observations only from a completed
collection pair. Omitted outcomes reject admission; any failed collection makes the
receipt unavailable with collection_failed. A completed collection may legitimately
contain no observations, preserving successful empty collection.

A populated-receipt fresh-file reconstruction test also passes: one referenced
observation is removed, receipt count remains1, read returns source_missing, foreign
key errors0 and read byte changes0. Metadata lifecycle remains separately held.

Corrected source validation: receipt/compaction/reviewability3files9tests and
subsequent typecheck/lint/build exit0. Updated compiled restart receipt includes
collection coverage. Two simultaneous child processes also returned inserted
true/false, one identical receipt ID, observations2/receipts1, FK0 and read byte
changes0. Evidence: observation-refresh-concurrent.{mjs,json} in the QA directory.

## Exact pair and size correction

The final scope is `members:[{source_id,worktree_id}]`, up to64 unique explicit
pairs. The outcome list must have the same cardinality, contain only those pairs,
and contain no duplicates. Independent source/worktree set coverage is no longer
used. A regression with4 configured pairs and only3 outcomes rejects before writes.
The canonical admission manifest is byte-checked against131072 before entering the
write transaction. A64-pair/256-character-ID scope with empty completed collections
fits and reads no_data;65 pairs reject with OBSERVATION_REFRESH_INVALID.

After these fixes, receipt/compaction/reviewability3files11tests and subsequent
Typecheck/lint/build passed. Earlier API-shaped fixture receipts predate the exact
pair contract; current process acceptance is rerun with explicit members.
