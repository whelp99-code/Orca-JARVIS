# ADR J05 — Isolated compare: current JARVIS engine vs DBOS

**Status:** accepted (not adopted)  
**Date:** 2026-09-20  
**Scope:** one synthetic read/draft workflow. No production-engine migration.

## Decision

Keep the current JARVIS execution engine. DBOS is **not adopted**.

## Workflow under comparison

Synthetic Core5 path: `mail.read` metadata then `mail.draft` envelope construction. JARVIS owns execution scheduling, attempt/lease fencing, and evidence. Mail send, CRM state, and Second Brain memory writes remain outside this engine.

## Current engine (bar)

| Bar | Current engine | DBOS |
| --- | --- | --- |
| Distinct `operation_id` / `attempt_id` / `lease_fence` | Yes, Core5 K02/J03 | Workflow+step ids; lease fence would be an extra mapping |
| TIMEOUT/UNCERTAIN ≠ success/fail | Explicit statuses | Typically retries/timeouts collapse toward failure unless wrapped |
| Duplicate side-effect suppression on new lease | Ledger + trigger | Durable workflows help idempotency but do not encode our approval digest + fence |
| Feature flag default off | `CORE5_INTEGRATION_ENABLED` | Would add a second runtime |
| No live Mail send | Registry omits `mail.send` | Irrelevant; would still need our gate |
| Isolated from production migrate | Yes | Adoption would be a production-engine move |

## Result

The current engine meets the bar for this synthetic read/draft workflow. Introducing DBOS would add an orchestration runtime without closing a gap we cannot already express in the ledger. **Not adopted. Do not migrate the production engine.**
