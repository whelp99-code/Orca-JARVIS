# Provider tombstone replica (read-fence gap)

## Decision

JARVIS signs a Second Brain read fence only over a tombstone head it has verified and stored.

Second Brain rejects any fence whose `(sequence, set_root)` is not its current `tombstone_replica` head (`TOMBSTONE_SET_STALE`). Production JARVIS `memory_tombstone_chain` is genesis. Production Second Brain is at sequence 3 because owner page correct/forget appended tombstones whose `keyed_subject_digest` is a subject digest, not `hmac-sha256:`. Migration 040's CHECK forbids copying those rows into `memory_tombstone_chain`, and re-appending them would mint a different root.

The fix is a separate table, `provider_tombstone_replica_*` (migration `099_provider_tombstone_replica.sql`). Second Brain exports the verified replica as a document signed with the provider result key (`second-brain/provider-tombstone-replica/v1`). JARVIS checks that signature, recomputes every link from genesis, and only then records the rows. `memoryReadHighWater` returns that head only after the stored links recompute to it. `signObservedMemoryReadFence` refuses any other tip. Read suppression treats the recorded target identities as active tombstones.

A new MCP tool was not added. `tools/list` must match the frozen contract length, so an extra tool would stop the running JARVIS transport. `sb_generation_status` already returns the head without the entries, and echoing that head would skip the invariant. The export is the read-only CLI `sb export-tombstone-replica`.

## Rejected

- Echo `sb_generation_status` high water into the fence. The reader would claim a set it has not recorded, so deleted content could be reused.
- Insert SB rows into `memory_tombstone_chain`. The digest format fails the existing CHECK, and a new append would not reproduce `sha256:567f53fc…`.
- Second Brain accepts a fence at an older sequence when the delta is only SB-originated. The provider would then serve a reader that has not observed those tombstones. Suppression on the provider side does not stop the reader from reusing a copy it already holds.

## Activation

1. Install this JARVIS release. Startup applies `099_provider_tombstone_replica.sql` only. Do not edit older migrations.
2. On the Second Brain host, with the production config that holds `provider_signing_key_id` and `provider_private_key`: `sb export-tombstone-replica > replica.json`.
3. On the JARVIS host, with `JARVIS_MEMORY_PROVIDER_INSTANCE_ID` set to that provider: `jarvis memory learn-provider-tombstones replica.json --key-file <provider-result-public.pem> --db <authority.sqlite>`.
4. Confirm the command prints sequence 3 and `sha256:567f53fc1a35573e370faaeb5b8f6d09b5a5d3900526f37527f26342cc545071`.
5. Re-run the existing outbox cycle (`jarvis memory outbox --once`) so `memout:pos:v2:942f9f8e…` can read with a fence Second Brain accepts and settle the already-proved remember. Do not mint a new remember for that row.
