# Gate state generation publication on current lineage visibility

2026-09-09. `writeCurrentState` bound generation lineage but wrote files and
replaced the current pointer even if that binding quarantined the generation.
It also failed every second publication to the same directory with EEXIST.

Reuse the generations directory through `secureRoot`, retaining owner/directory/
symlink checks. Check generation suppression immediately after binding, before
creating generation files. After asynchronous file writing and syncing, check
both root identities, prepare the temporary pointer, then check suppression again
and synchronously rename under an IMMEDIATE SQLite transaction. No await occurs
between the final visibility check and pointer replacement, excluding concurrent
SQLite suppression writers during that boundary.

If rejected before pointer replacement, remove the new private generation and
temporary pointer and preserve the prior generation. Once pointer replacement
has occurred, a later sync/commit failure must not delete the referenced directory:
propagate the failure, retaining artifacts for inspection. This is not an atomic
SQLite/filesystem durability transaction; a failed call after rename is uncertain,
not evidence of no publication. Post-publication suppression and old generation
purging remain separate lifecycle work.

Initial tests exposed EEXIST before reaching the suppression boundary. After the
directory-reuse fix, both early quarantine (1100 pending control decisions exceed
the collector's bounds) and quarantine injected after generation-file sync wrongly
resolved successfully. These are the two regression cases for publication gates.
Also verify repeated successful publication and post-rename sync failure leave a
readable current generation. Fixtures operate on temporary roots and isolated DBs.

Untracked sources and other source-admission limitations are not certified by this
gate. No production deployment, restart, or schema mutation is performed.

Validation: 16 tests across publication gates, approved executor, persisted memory
readers and reviewability passed (24.50s). Backend build, lint and all three
TypeScript configurations exited 0. Compiled Node processes 909261/909371 published
successive generations to one temporary root. A third publication with 1100
fixture pending decisions rejected with `STATE_PROJECTION_SUPPRESSED`, preserving
the second process's current pointer. The process experiment exited 0; source
records are synthetic and this is not production source-admission acceptance.

Review correction: after pointer replacement, wrap errors in
`STATE_PROJECTION_OUTCOME_UNCERTAIN`. The approved executor classifies this exact
code for `state.project` as uncertain and stores `command.uncertain`; it must not
settle as a confirmed failure. An executor-level injected sync failure checks both
the returned and persisted uncertain states and that the published JSON exists.
After correction, 16 tests in three files passed (23.25s), plus backend build,
lint and three TypeScript configurations exit 0. Initial review was fix-first.

Residual: concurrent first-time directory bootstrap can still fail EEXIST in
`secureRoot`'s check-then-create; sequential reuse is the behavior verified here.
