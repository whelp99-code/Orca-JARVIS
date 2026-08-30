# JARVIS Operator Recovery

## Daily loop

1. Inspect the Today surface on the local control center.
2. Treat `uncertain`, `failed`, and expired leases as unresolved until evidence is recorded.
3. Reclaim only after the lease expiry; never reuse an old fence.
4. Complete a run only through `running -> verifying -> completed` with a result digest.

## Terminal evidence

Terminal events persist command, stdout, and stderr digests. Raw output is not written to the personal operations database. Use `scripts/collect-terminal-evidence.mjs` only for structured ORCA-unavailable events; it rejects keypress, stdin, and password-shaped fields.

## Memory delivery

Candidates are classified before queueing. Sensitive, restricted, and inferred candidates require current human confirmation. A provider `accepted` response remains `accepted_unsettled` until the expected artifact selector returns the expected digest. A mismatch is `uncertain`, not success.

## Remote access

The phone gateway binds to `127.0.0.1` and is intended to be reached through the approved tailnet path. It exposes safe read routes only. Remote WebAuthn assertions must match the challenge's request, principal, credential, session, nonce, origin, RP ID, command digest, target digest, and argument digest.

## Rehearsal

Run:

```sh
node scripts/personal-os-recovery-rehearsal.mjs
```

The command emits schema-versioned JSON and checks the evidence collector, loopback binding, service hardening, and persistent KST refresh timer. It does not mutate databases, leases, worktrees, or deployment state.
