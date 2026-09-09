# Integrate scoped provider progress with JARVIS development

2026-09-09. Development HEAD063bcfa and main623afa6 diverged by105/16 commits.
The main-side commits add read profiles v3-v5, frozen scoped-write-v1, recovered
acceptance/completion evidence, atomic settlement and current gateway authority.

Merge the exact main commit into the isolated development branch. Keep the existing
domain export barrel and centralized transport profile validation; add the upstream
profiles and exports to those boundaries. Preserve both branches' migrations byte
for byte. Keep prior cancellation, task suppression and gateway session checks.

The added provider verification route belongs in a focused HTTP handler when the
owner request module exceeds its reviewability limit. This extraction must preserve
body, session recheck, error and response behavior. Long lines are expanded without
removing checks or changing the module-size acceptance rule.

Validate scoped read/write/recovery/settlement, compaction, gateway authentication
and runtime reviewability together. Then inspect the complete integration diff and
obtain independent read-only review before committing the merge. The running full
gate in the other worktree remains frozen at063bcfa and does not cover this merge.

The provider worktree is independently active and dirty; no files there are changed.
The new contract does not by itself prove task→candidate→provider-record deletion
lineage. collect-task and production activation remain HOLD pending that acceptance.

Review found that historical reconstruction exposed the private request after local
candidate/outbox quarantine, also allowing settled replay. Historical evidence is
not an exception to current visibility. Check candidate/outbox suppression and
quarantine inside the same reconstruction transaction before opening private spool
bytes; proof and settlement replay transitively retain that guard. Preserve stored
settlement evidence and reject without writes. This is local visibility enforcement,
not the still-missing task-to-provider deletion lineage contract.

The full migration filename is the journal identity. Both committed parents also
contain distinct migrations numbered079 and080: scoped observations versus task
read indexes, and late subject suppression versus scoped settlements. Preserve
all four filenames and bytes. Extend both exact collision assertions by these two
pairs; continue rejecting any other collision. This follows the existing072–075
immutable-history policy, not a general exemption for duplicate numbering.

Parent-database upgrade probes apply84/80 original files then the merged86-file
vector. Original journal rows/checksums/timestamps remain unchanged; repeat migrate
writes0, foreign-key errors0, quick_check=ok in both cases. These are isolated empty
parent databases, not populated production upgrade acceptance. The existing scoped
settlement/compaction regressions cover populated new structures separately.
