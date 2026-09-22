# Core5 status

## Verification

- Targeted command: `TMPDIR=/tmp node node_modules/vitest/vitest.mjs run tests/unit/core5-integration.test.ts tests/unit/core5-j04-mail-drafts.test.ts --no-file-parallelism --reporter=verbose --configLoader=runner`.
- External Vitest binary source: `/home/jm/orca/projects/Orca-JARVIS/node_modules`.
- Node `v24.19.0`; test files `2 passed`; tests `20 passed`; duration `5.73s`.
- No dependency installation was performed.

## JARVIS-owned status

- J01: capability registry covers the eight planned read/state/request capabilities; `mail.send` remains unregistered.
- J02: verified caller context and self-asserted permission rejection are covered by existing tests.
- J03: operation, attempt, and lease identities remain distinct; `TIMEOUT` and `UNCERTAIN` classify as neither success nor failure.
- J04: draft handoff remains human-owned; approve/send/cancel are rejected by the gateway and no approval/cancel path is called.
- J05: DBOS comparison remains explicitly not adopted.
- J06: cancellation distinguishes `CANCELLED` from `CANCELLED_AFTER_POSSIBLE_EFFECT`; synthetic executor is read-only.
- K04/K05: blocked on sibling C06/B06/M06/H02-H04/H06 acceptance; no cross-repo acceptance is asserted.

## Product-fixable follow-through

Capability records now expose `available`, `degraded`, or `blocked` status. The global Core5 flag defaults off and reports capabilities as `blocked`; explicit per-capability status environment variables can surface sibling outages, and blocked capabilities cannot execute.
