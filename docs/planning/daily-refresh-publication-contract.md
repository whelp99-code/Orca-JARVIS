# Daily refresh publication evidence

Status: proposed JARVIS integration contract, not implemented provider support.
JARVIS inspected at1afdde6; Second Brain inspected at
bfdf38f593a9f2bce51a59b3817a8c7d27bed2a9. No provider files changed.

## Current verified boundaries

- cli-evening-inputs.ts and cli-daily-commands.ts install refresh_reader.read returning
  null. Configured daily operation currently reports provider refresh unavailable.
- daily-loop-types.ts RefreshCompletion contains schema_version, refresh_id, state,
  completed_at, protocol_version and capped. evaluateRefreshContext checks outcome,
  protocol, cap and freshness. It does not bind a provider, scope or generation.
- Second Brain sb/mcp.py sb_generation_status pins a generation and requires the
  memory_status read fence. It returns provider identity/release, generation/manifest,
  vault head/tree, tombstone high-water and pointer/journal health. The inspected
  response has no refresh completion timestamp, refresh request identity or cap flag.
- sb/generation_runtime.py builds a generation before activation. Activation is
  conditional on authority.activate. A completed build is therefore insufficient to
  prove the generation was published.

## Composition to implement

Use the existing authenticated scoped transport and current-generation read fence.
Do not treat the internal six-field RefreshCompletion as external authority.

A provider refresh receipt must bind its request identity, requested scope, provider
instance/release, completion time, cap/completeness outcome and resulting generation
manifest. Publication time must represent successful activation, not staging/build
completion. Read current generation status under the same authority and verify that
its generation/manifest matches that result before creating the internal completion.
If the pointer advances or scope/authority changes before consumption, retry within
the daily lease or return an explicit degraded/unavailable result. Never reuse a
historical successful refresh timestamp as proof of the currently active generation.

The provider-side receipt schema and endpoint remain to be agreed with the Second
Brain task; existing sb_generation_status alone cannot supply all these fields.
JARVIS should reuse existing transport/session/fence code, add the receipt validation
at its adapter boundary, then inject the validated reader into the configured daily
loops. Persist provenance for the daily artifact so restart can trace its inputs.

## Required acceptance

Actual provider refresh -> activation -> authenticated status -> daily publication,
with matching source lineage. Negative cases: build without activation, failed
activation, newer unrelated generation, wrong scope/provider, revoked read fence,
capped refresh, stale/future completion and daily lease expiry during provider I/O.
Recovery must not label a historical receipt as current readiness or repeat a write.

Direct wiring from readiness.last_successful_refresh_at or unbound JSON is on hold.
This is a dependency boundary, not a decision to leave provider refresh permanently
unimplemented. Broader backlog01–25 remains active.
