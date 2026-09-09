# Subject suppression on late projection binding

Backlog22 privacy prerequisite, 2026-09-09. Inspection found an inconsistency:
`MemoryProjectionAuthority.activateForSequence` matches keyed subject identity,
but `MemoryProjectionLineage.activateRef` previously matched only target/source/
content/citation identities. Consequently a same-subject projection bound after
its tombstone, or inherited later from a suppressed parent, could remain visible.
This was reproduced in an isolated authority DB; no production exposure was measured.

The late-binding query now includes keyed-subject equality. Unrelated subjects
remain visible. Binding and inherited binding still occur in the existing immediate
transaction, and reads remain free of repair writes. Projection counts in prior
suppression events remain the original event-time snapshot, not a mutable total.

Forward migration080 materializes missing same-subject projection suppressions for
existing dependencies and active suppressions. It preserves tombstone, source,
event and dependency rows. Repeated application does not duplicate suppression
links. It does not remove existing suppressions, rewrite original events, or
attempt to recall provider records. Upgrade must use the normal controlled
migration/service lifecycle, not a live database mutation.

## Verification

- Initial fixture attempt52413 failed before the scenario (missing local target).
  Corrected fixture90978 reproduced2 assertion failures: late root visible and
  late inherited child visible. These are retained in late-subject-reproduction.log.
- After correction41955:11tests/3files11.44s passed. Covers both bind orders,
  inherited subject suppression, unrelated subject visibility, real ControlPlane
  reads with zero writes, existing11 read contexts, readiness and populated upgrade.
  Upgrade repairs an existing late dependency and preserves original ledger rows;
  repeated migrate, FK check and quick_check pass.
- Build17286 exited0 (migrations84); lint/three typechecks84127 exited0.
- Actual compiled process check:2 independent Node readers each returned
  linked_visible=false, unrelated_visible=true, child_suppressed=true, read_writes=0.
  Provider calls0, operational changes0. Script/receipt late-subject-live.mjs/.json
  under `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.
- Direct regression24449 was interrupted by tmp storage EDQUOT(-122)/SQLite I/O
  failures:17pass/5fail plus5 suite-load errors. No product correction was made
  for those environment errors; rerun uses the repository scratch-isolating runner.
- Final repository-runner regression54248:49tests/11files43.31s passed.
- Fixed-clock acceptance/CLI smoke7728 exited0. Native late_subject_review
  returned ship/findings0, parent packet hashes3/3 matched. Requested terra/high;
  actual model/effort and token usage unavailable.

## Remaining boundary

This fixes an existing local projection-suppression inconsistency. It does not
implement task-to-candidate provenance, source-to-provider deletion propagation,
remote two-client read suppression, restoration lineage, automatic collection or
operational activation. The full prerequisite in task-memory-source-privacy-hold.md
remains HOLD until those end-to-end requirements are satisfied.

Late binding does not rerun notification terminalization or republish historical
suppression events. In-flight notification state handling remains a separate
required follow-up; local read suppression is not proof of external recall.
