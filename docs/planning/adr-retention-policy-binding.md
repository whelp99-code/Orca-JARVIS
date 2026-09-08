# Retention cutoff fixed at job creation

Date: 2026-09-09

## Problem

Retention execution accepted its cutoff only from the executing caller. A job reclaimed
after a process restart could therefore execute under a different deletion cutoff.
The receipt bound the supplied policy, but job identity did not bind that policy.

## Decision

Migration 074 adds nullable `policy_cutoff` to existing retention jobs without changing
shipped migrations. Newly created jobs require a canonical UTC millisecond cutoff no
later than `createdAt`. A database trigger forbids subsequent cutoff changes, including
changing a legacy NULL to a value. Data class already belongs to immutable job identity.

Execution compares its expected cutoff with the persisted value inside the same
immediate transaction as lease validation and adapter execution. Missing or mismatched
policy fails with `E_RETENTION_POLICY` before any adapter call. The existing failure
settlement marks an owned job failed; its caller must create a separately identified
job with an explicit policy rather than silently rewriting or retrying the old policy.

Legacy rows remain intact after migration, but execution is withheld until a new job
with an explicit policy is created. Migration does not infer an operator's deletion
intent. Claiming a legacy row remains possible; claiming is not permission to delete.

## Verification scope

Regression coverage checks mismatched policy with zero adapter calls, legacy NULL
policy rejection, invalid creation with zero inserted jobs, existing receipt and
rollback behavior, and expired-lease recovery. An actual 073-to-074 database upgrade
test preserves an existing row, rejects retroactive binding, repeats migration and
runs SQLite quick_check.

Measured locally: backend build, lint and all three typechecks exited 0; three test
files passed 21 tests in 11.11 seconds. Compiled Node processes 1055979 and 1056069
used a temporary file-backed database and injected timestamps. The child reclaimed
both jobs at fence 2, rejected the mismatched cutoff with zero adapter calls and its
fixture row intact, then deleted one fixture row under the matching persisted cutoff.
Child exit was 0. Receipt: `/tmp/jarvis-retention-policy-24DK0W/receipt.json`.
This is process-restart evidence with fixture data, not production deletion acceptance.

## Remaining operational work

The runtime still requires synchronous adapters on its own SQLite connection.
Concrete production deletion adapters, policy-authorized scheduling, and service
wiring remain HOLD. This binding does not establish approval, prove that an adapter
honors the cutoff, or authorize deletion of signed evidence. Deployment and production
database migration have not been performed by this change.
