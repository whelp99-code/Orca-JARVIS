# Personal Operating System Architecture

Status: frozen design contract for todo 9 and later implementation. This document does not claim that the personal-operating-system types, persistence, connectors, gateway, transfer, restore, or deletion workflows are implemented.

## Authority and host boundary

Linux is the sole JARVIS authority and production runtime host. `AuthorityDb`, `ControlPlane`, schedulers, workers, the approved executor, audit state, and private gateway authority run there. Production Second Brain is a separate Linux-hosted provider reached only through typed stdio MCP. JARVIS does not parse or mutate its vault directly and does not maintain a second personal-memory store.

The Mac is only an Electron/browser client, native notification/deep-link integration and authenticator surface, packaging target, and real-surface QA host. The phone is only a private authenticated browser/client and authenticator surface. Neither owns runtime state, policy, approval, execution, memory, or an authority fallback. Disconnecting either cannot stop Linux runtime, memory refresh, persisted notification intents, backups, or audit.

Production Second Brain starts with an empty Linux vault generation and typed `no_data`. JARVIS remains bootable and memory-dependent decisions abstain. Importing the existing Mac vault from frozen source `main`/`d921878eedcf55014eb8cf48e3383a6ba6a5f86e` requires exact approval `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL`. Restoring production data is a different operation requiring exact approval `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL`; one never satisfies the other.

## Source-of-truth and host-ownership matrix

| Domain | Canonical owner | Runtime host | Producer -> consumer | Persistence | Freshness / expiry | Failure disposition | Forbidden authority escalation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Authority | JARVIS `AuthorityDb`; `ControlPlane` + approved executor | Linux JARVIS | authenticated human approval + deterministic policy -> control plane -> executor | durable requests, single-use receipts, fences, effects, revocations, audit | command, receipt, challenge, lease expire independently and must be current at effect time | reject/cancel/fail; in-flight unknown effect is `uncertain` | no client, model, memory, observation, recommendation, timeline, workflow prose, or notification may mint/replace authority |
| Live observation | registered adapter for its measured source | Linux JARVIS; identified clients may submit bounded non-authoritative evidence | adapter -> context/projection/verifier | immutable bounded envelopes/checkpoints; no raw transcript/body | `observed_at`, `fresh_until`, `expires_at` by source | preserve `no_data`, `stale`, `unavailable`, `offline`; abstain if required | never authorizes and never becomes durable memory automatically |
| Durable memory | Second Brain generations, provenance, conflicts, tombstones | separate Linux Second Brain | approved/confirmed outbox -> stdio MCP -> pipeline; cited reads -> context | Second Brain only; JARVIS stores refs, delivery state, digests, non-content tombstones | valid/retrieval times; stale/conflicted/expired evidence advisory or excluded | explicit `no_data`/stale/conflict/unavailable/uncertain; reconcile or abstain | advisory only; cannot define policy, instructions, tool scope, approval, or live truth |
| Context | immutable `ContextSnapshotV1` under deterministic policy | Linux JARVIS | bounded authority/live/memory evidence -> recommendation/clients | bounded refs, omissions/conflicts, digest, expiry in AuthorityDb | earliest required input deadline and explicit expiry | `insufficient`/`abstain`; never silently omit required source | cannot mutate policy or become a receipt |
| Recommendation | deterministic JARVIS policy over frozen context | Linux JARVIS | parsed bounded model advisory + policy -> inbox/human | recommendation, citations, policy decision, expiry | cannot outlive context or critical evidence | `abstained`, `expired`, `rejected`; no dispatch | rank/confidence/model prose cannot approve, execute, or bypass parsing/policy |
| Workflow | JARVIS workflow/LoopGraph correlated to control request | Linux JARVIS | approved request -> executor/workers -> verifier | run, steps, checkpoints, leases/fences, receipts/evidence | recheck lease/checkpoint/approval at every effect | retry only known-safe idempotent work; else failed/blocked/uncertain | worker output, progress, prompt return, timeline state cannot authorize/prove completion |
| Notification | JARVIS notification intent | Linux creates/redacts/persists; Mac may deliver | policy -> intent -> delivery adapter -> deep link | redacted intent, dedup, delivery receipt in AuthorityDb | quiet-hours decision and expiry | defer/suppress/expire/fail; core loop continues | no command, credential, approval, executable authority; interaction only opens authority UI |
| Remote identity / approval | Linux principal registry, challenge verifier, existing control receipt path | Linux gateway/authority; clients present assertion only | principal + exact WebAuthn assertion -> verifier -> existing receipt | public credential metadata, single-use challenge/assertion digest/receipt/audit | short expiry, exact principal/session/command binding, one use | wrong principal/mismatch/expiry/replay/version fails closed | tailnet, session, biometric gesture, client claim alone never authorize |
| Deletion | Second Brain active-store deletion + JARVIS non-content tombstone/audit | Linux JARVIS coordinates; Linux Second Brain applies | exact approved delete -> outbox -> purge/reindex -> reconciliation | purge active stores/indexes/exports/caches; retain minimal tombstone | tombstone durable and dominates older/imported generations | partial/uncertain stays pending and blocks restore/import activation | restore/transfer/import/model/backup cannot resurrect tombstoned content |
| Audit / evidence | AuthorityDb for effects; Second Brain provenance for memory | respective Linux owner | deterministic executor/verifier -> auditor/timeline/client | append-only minimized digests, receipts, correlation, outcomes | event time immutable; validity/retention explicit | missing/unverifiable means not proven; external effect may be uncertain | display and Task Timeline are projections, never authority/verification substitute |
| Client projection | Linux read APIs over canonical owners | Linux serves; Mac/phone render | canonical stores -> bounded redacted projection -> client | bounded expiring cache only, never canonical | generated-at and expiry; stale cache visibly read-only | degraded/offline display, mutation disabled, no local fallback | UI/cache/cards/deep links/notifications cannot become authority or memory truth |

## Data and control flow

```text
live adapters --------------------> observation envelopes --+
TaskTimeline (read-only evidence) ---------------------------+--> context snapshot --> recommendation
Second Brain typed stdio MCP -----> cited memory evidence ---+          |                  |
AuthorityDb ----------------------> pending decisions -------+       abstain or             v
                                                                  advisory display   exact human approval
Mac/phone <--- redacted projection/notification --- Linux ControlPlane --> approved executor
                                                           ^                 |
                                                           +-- audit/evidence+
verified outcome -> memory candidate -> confirmation/approval -> outbox -> Second Brain
```

Arrows into context are evidence flow, not authority flow. A recommendation can only cause an authority request. Only `ControlPlane` validating a current exact receipt and an approved executor holding the current fence can authorize and perform an effect.

## Deterministic invariants

1. Memory is advisory/context only and cannot authorize or replace required live observation.
2. Only Linux `ControlPlane` plus the approved executor can authorize and perform effects. Approval is exact, expiring, single-use, principal/digest-bound, and fence-checked.
3. `TaskTimeline` and progress are read-only observation/evidence projections. Agent claims, idle state, prompt return, and projected completion are not authority or verification.
4. `stale`, `unavailable`, `offline`, `no_data`, conflict, and insufficient evidence cause deterministic abstention; none is fabricated empty success.
5. Wrong principal and expired, mismatched, unknown-version, or replayed challenges/receipts fail closed.
6. A deletion tombstone dominates restored, transferred, imported, cached, indexed, or generated memory. Activation waits for tombstone reapplication and proof that forgotten sentinels are absent.
7. `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL` and `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL` are separate exact approvals with separate digests, manifests, windows, and receipts.
8. Model output and retrieved text are untrusted payload data. Parsing, allowlists, limits, policy, and approval remain outside prompts; payload cannot mutate instructions, policy, tool scope, retention, identity, or authority.
9. Observation never becomes memory automatically. Only a classified candidate satisfying confirmation/approval policy enters the outbox; delivery settles only when the expected cited Second Brain artifact is observed.
10. Unknown envelope versions and identifiers fail closed at every boundary.

## Existing seams and future ownership

- Implemented: [`ControlPlane`](../../src/control-plane.ts) stages, decides, claims, settles, cancels, and recovers commands with signed receipts, expiry/replay checks, leases, fences, and uncertain outcomes.
- Implemented: [`TaskTimeline`](../../src/task-timeline.ts) composes existing work/control/workflow/GJC/verification/progress records under a read-only mutation guard. It is not a personal context store or authority.
- Existing governing references: [architecture contracts](../planning/03-ARCHITECTURE-CONTRACTS.md), [Task Timeline](../TASK_TIMELINE_KO.md), and [Master Charter](../../ORCA_MASTER_CHARTER.md).
- Separate Second Brain at reviewed HEAD `011abade5b29de66af4722dfd9c21398064eeb1e`: `sb/contracts.py` defines current pipeline data classes; `sb/mcp.py` exposes `sb_search`, `sb_read_page`, `sb_recent_changes`, `sb_open_conflicts`, `sb_remember`. `sb_remember` returns an inbox path, not indexed settlement proof.
- Future todo 9 owns the types/parsers/identifiers in [contracts.md](contracts.md). Todos 7-8 own persistence; 10-12 MCP; 13-18 observation/context/recommendation; 19-30 loops/workflow/memory feedback; 33-35 notification/remote approval; 36 transfer/restore. These are targets, not current capabilities.
