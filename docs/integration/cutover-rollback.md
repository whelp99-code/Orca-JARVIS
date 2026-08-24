# Cutover and rollback

Production cutover requires owner approval. Rehearsal is not cutover.

Gate blocks when: invariant mismatch, unresolved `uncertain`, duplicate protected effect, permission gap, or operator QA failure.

Pre-activation rollback restores the snapshot. Post-activation rollback is pointer-only when the current manifest is backward-readable; otherwise N+1 stays up for forward repair.
