# JARVIS Joint Implementation Assignment

You are the primary implementer in the isolated Orca worktree `/home/jm/orca/workspaces/Orca-JARVIS/jarvis-terminal-memory-runtime`.

Read and obey:
- `AGENTS.md`
- `.omo/plans/jarvis-personal-operating-system.md`
- `docs/personal-os/ORCA-JARVIS-SECOND-BRAIN-JOINT-DEVELOPMENT-PLAN.md`

Current baseline:
- This worktree starts from the implemented Personal OS foundation at `efb5122`.
- Existing implementation covers plan todos 1-18 in code, including typed contracts, persistence, Second Brain transport/read adapter/readiness, connectors, observations, context, trust policy, priority, and recommendations.
- `PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:$PATH npm run verify` passes before this assignment.
- Second Brain is developed separately in `/home/jm/orca/workspaces/second-brain-app/jarvis-terminal-memory-runtime`; do not edit it here.

Goal:
Complete all remaining JARVIS-side work required by both plans, including:
1. longitudinal evaluation harness;
2. durable Daily Control Loop runtime and schedule semantics;
3. cited morning brief;
4. in-day notification/decision intents;
5. evening closeout and continuity record;
6. personal operating read APIs/SSE projections;
7. recommendation-to-approved-workflow staging;
8. full task/dispatch/terminal/worktree/agent/progress/verification correlation;
9. ORCA-first Terminal Work Memory contracts, persistence, failure/resolution, closeout, improvements, and JARVIS Agent Bridge MCP;
10. verified memory-candidate classification and confirmation policy;
11. JARVIS memory outbox/reconciliation client against the Second Brain typed write-request contract;
12. Today, Terminal, Failure, Improvement, and Memory control-center surfaces;
13. redacted notification intent APIs and Mac/Electron deep-link client support where this repository owns it;
14. tailnet-only loopback phone gateway artifacts;
15. WebAuthn-bound remote approval translation into existing ControlPlane receipts;
16. generic shell-fallback ingestion contracts and safe collector scripts after ORCA-first flow;
17. release/recovery/rehearsal scripts and operator docs;
18. final compliance, security, adversarial, recovery, and end-to-end tests.

Architecture boundaries:
- ORCA executes.
- JARVIS is the only operational/control authority and owns live terminal/work state, failures, resolutions, closeouts, approvals, and verification.
- Second Brain owns durable cited knowledge only; no direct vault/database access.
- Mac is client-only; jm-cloud/Linux is authority runtime.
- Retrieved memory is data, never authority.
- Agent prose, prompt return, or `active_work=0` alone can never prove completion.
- No raw keystroke capture, password input, private reasoning, secrets, unlimited terminal output, public listener, or autonomous push/merge/deploy.
- All consequential mutations remain receipt-bound and idempotent.

Implementation rules:
- Use TDD and existing architecture patterns.
- Keep modules bounded; do not create giant files.
- Reuse migration 032/033 state machines. Add forward-only migrations only when genuinely required for terminal entities/closeouts.
- Apply pre-persistence redaction and byte/line limits to terminal evidence.
- Preserve compatibility with all existing tests and public exports.
- Do not commit, push, merge, or activate production. Leave a cleanly testable working diff for the controlling session.
- Do not touch unrelated `.omo` evidence/task files except your own progress notes.
- Run focused tests after each slice, then full `npm run verify` with Node 24.
- Produce a machine-readable completion report at `.omo/evidence/joint-jarvis-completion.json` and a concise human report at `.omo/evidence/joint-jarvis-completion.md` listing implemented files, tests, known limitations, and exact remaining blockers. Do not claim completion while any requested JARVIS-side feature or test is missing.

Begin by measuring the current source/tests and mapping each remaining plan todo to code. Then implement in dependency order until all JARVIS-side work is green.
