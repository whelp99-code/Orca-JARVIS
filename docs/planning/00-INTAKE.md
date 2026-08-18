# JARVIS Capability-Aware Team Proposal Plan — Intake

## Status

- `CONFIRMED` Plan state: READY.
- `CONFIRMED` Tier: M — 3 MUST requirements, 20 unique changed files, 1 forward-only migration, highest risk R3.
- `CONFIRMED` Baseline branch: `feat/jarvis-argo-cli-jaw-integration` at `695705e`.
- `CONFIRMED` Existing implementation plan: none found under `docs/planning/`, `.omo/plans/`, or `*plan*.md`.

## Objective

Add a read-only capability matrix and capability-aware team proposal layer without weakening JARVIS authority boundaries. Add typed negative evidence as immutable authoritative data while keeping Markdown projection-only.

## Actors and flow

1. An operator requests `capabilities --json` or runs `doctor`.
2. JARVIS reports factual capability states: `installed`, `configured`, `protocol_compatible`, `operational`, and `authorized`.
3. A caller submits a bounded team-proposal request.
4. JARVIS returns either 2–3 missing-information questions or a non-authoritative team proposal.
5. An approved control command may record a failed approach as typed negative evidence.
6. Timeline and current-state projections expose that evidence without creating a second writable collaboration store.

## In scope

- `REQ-CAP-001`: typed, read-only capability matrix.
- `REQ-TEAM-001`: deterministic proposal-only archetypes and bounded interview.
- `REQ-EVID-001`: immutable typed negative-evidence ledger through approved execution.

## Out of scope

- Worker spawning, team member replacement, detached CLI jobs, direct `codex --full-auto`, and `agy --dangerously-skip-permissions`.
- Mutable shared Markdown, chat rooms, collaboration memberships, or reactivation of migration 025 tables.
- Treating model prose, plans, or team proposals as authorization.
- Automatic installation, login, credential mutation, deployment, or terminal mutation.

## ASSUMED

| ID | Assumption | Basis | Impact | Rollback |
|---|---|---|---|---|
| A-001 | Existing flat fields from `capabilities --json` remain during this plan. | `tests/integration/task-timeline.test.ts` asserts them. | Adds a nested matrix without breaking current consumers. | Remove only the nested matrix before release if compatibility fails. |
| A-002 | Team proposals are ephemeral CLI/library outputs and are not persisted. | Proposal prose is not authority; no durable team entity exists. | Avoids a second state store. | Remove the proposal command and export. |
| A-003 | Negative evidence requires an approved control receipt. | All new authoritative mutation must follow `ApprovedCommandExecutor`. | Adds one migration and one action handler. | Stop issuing the action; immutable rows remain auditable. |

## Questions

N/A — repository evidence resolves the safe defaults. No product decision is required before implementation.

