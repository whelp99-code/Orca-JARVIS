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

## Reinspection — 2026-09-10

Read-only inspection at Second Brain HEAD235a2e4 found sb_generation_status still
returns generation/provider/tombstone/health and versioned features, without a
refresh request identity, completion time or cap/completeness outcome.
GenerationRuntime still activates conditionally on mutation.authority.activate.
The publication receipt dependency therefore remains open; no provider files were
changed and no generation status was relabeled as a completed refresh.

## Second reinspection — 2026-09-10, Second Brain HEADd1d06e2

The reinspection above is superseded. The provider workspace
`/home/jm/orca/projects/second-brain-app` is on branch
`codex/shared-memory-completion-20260907` at `d1d06e2`, which is 26 commits ahead
of `235a2e4`, with 4 uncommitted entries. Source was read only; no provider file
was opened for writing and no provider process was executed, so nothing below is
a live response.

That workspace is under active concurrent work: its HEAD advanced from `d1d06e2`
to `832bc6b` while this section was being written. Everything below is a
point-in-time reading of `d1d06e2` and must be re-read before it is relied on.

A profile that did not exist at the earlier inspection is now present.
`deploy/check-release-mcp.py` lists `scoped-request-status-v1` exposing
`sb_request_status`, implemented in `sb/scoped_status_mcp.py` and
`sb/scoped_request_status.py`. For a request in state `proved`,
`read_scoped_request_status` returns `schema_version` 4,
`provider_instance_id`, `request_id`, `request_digest`, `scope_digest`, `state`,
`phase` and `updated_at`, plus a `proof` object binding `content_digest`,
`generation_id` matched against `sbgen:v1:[0-9a-f]{64}`, and `head`/`tree` as
40-hex values, plus a reconstructed `receipt` carrying `proof_digest`,
`status_digest`, `updated_at` and code `PROVIDER_PROVED`. The MCP surface wraps
that with the profile name, request digest, access-claim digest, provider
instance and the tombstone sequence/root it was read under, and it re-resolves
the scope before and after the read.

That closes more of the receipt requirement than recorded before. Request
identity, requested scope, provider instance and the resulting generation
identity are now bindable from one authenticated read, and
`sb_generation_status` separately reports the **active** generation manifest
under the `memory_status` fence, which is the counterpart needed to check that a
historical proof still matches what is live.

Three gaps remain, and they are the reason this is still a dependency.

- No cap or completeness outcome appears in either surface.
- Only `provider_instance_id` is exposed; a provider release identity is not.
- Neither surface attests current availability, by explicit design.
  `sb/scoped_status_mcp.py` documents its tool as "Read the original request
  journal; never evidence of current artifact availability", and
  `sb/scoped_request_status.py` states "Historical proof is not evidence that the
  artifact is still current or has not been deleted". A refresh completion must
  therefore still be constructed by JARVIS from a proof plus a same-fence active
  generation comparison, not lifted from either response.

Whether a provider refresh maps onto one of these scoped write requests at all is
a counterpart question and is not assumed here. The JARVIS-side distinction of
unset, failed, incompatible, capped, stale and fresh is already implemented in
`evaluateRefreshContext` and pinned by `tests/unit/daily-control-loop-time.test.ts`;
what is still missing on this side is only the adapter that validates a provider
receipt and injects a non-null reader, which cannot be written until the two
fields above and the refresh-request mapping are agreed.
