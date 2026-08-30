# Joint Runtime Wiring — Exact Missing Slice

Work only in `/home/jm/orca/workspaces/Orca-JARVIS/jarvis-terminal-memory-runtime`.
Read `AGENTS.md` and current code. The full baseline now passes 147/958 backend and 20/100 dashboard. Immutable migration 033 has been restored; terminal/outbox extensions are in `migrations/034_terminal_work_memory.sql`. **Never edit migration 033.**

The prior worker created many domain classes but did not wire several production runtime paths. Implement and verify the missing wiring below. Do not claim completion from isolated class tests.

## 1. Standards-compatible JARVIS Agent Bridge MCP executable

Create a real stdio MCP server executable, not only `JarvisAgentBridge.handle()`:
- support JSON-RPC/MCP initialize, notifications/initialized, ping, tools/list, tools/call;
- expose all nine `jarvis_*` tools with bounded JSON Schemas, descriptions, standard MCP `content` text and `structuredContent`, `isError` on tool errors;
- use `JARVIS_DB` (required) and open/migrate/assert the AuthorityDb safely;
- max frame 1 MiB, line-delimited JSON, no stdout logs other than protocol, redacted stderr;
- graceful EOF/SIGTERM and DB close;
- add executable entrypoint, package script/bin or stable release wrapper;
- add protocol tests, malformed/oversize frame tests, read/write tool tests, and an interoperability smoke using the existing Python MCP client if locally available.

## 2. Exact Second Brain provider client and memory settlement service

The current `SecondBrainTransport` only freezes the old compatibility tools and does not call provider tools. Add a separate, typed provider profile without weakening the existing compatibility contract:
- launch the same immutable provider executable with `SB_MCP_PROFILE=provider`, `SB_CONFIG`, minimal env;
- require exact provider tool set: `sb_provider_health`, `sb_write_request`, `sb_request_status`, `sb_reconcile_write`, `sb_restore_request`, `sb_observe_artifact`, `sb_export_history` plus the six compatibility tools;
- bounded startup/read/write deadlines, one serialized mutation, safe read retry only, uncertain disposition for interrupted writes;
- typed parsing of health/request/status/reconcile/artifact responses;
- implement a `MemorySettlementService` that claims `MemoryOutbox`, sends the exact Second Brain `second-brain-write-request-v1`, preserves candidate/closeout/receipt/purpose/sensitivity/retention/source refs, records accepted/rejected/uncertain, reconciles lost responses by request status/artifact observation, and settles only on exact expected digest;
- no direct vault or provider SQLite access;
- add fixture child tests plus a real local cross-process smoke target configurable by `SECOND_BRAIN_PROVIDER_BIN`/`SECOND_BRAIN_PROVIDER_CONFIG`.

## 3. Daily Control Loop executable/service

Wire `DailyControlScheduler`, morning brief, notifications, evening closeout, terminal unresolved failures, recommendations, and memory candidate generation into an executable Linux runtime:
- `once` and supervised `run` modes;
- KST morning 07:15 and evening 21:30, event/in-day reconcile hook, lease/fence/restart-safe behavior;
- wait/degrade honestly for Second Brain refresh, never invoke refresh itself;
- no Mac dependency;
- expose status JSON;
- add hardened `jm-jarvis-daily-control.service` and timer/path or event mechanism as appropriate;
- tests for no-data/offline/stale, duplicate schedule, restart, quiet hours, failed verifier, unresolved P0/P1, and Mac absent.

## 4. Shell fallback executable and installation artifacts

`collect-terminal-evidence.mjs` currently validates only and does not persist. Add a bounded executable that:
- reads JSONL from stdin or a 0600 spool file;
- opens/migrates JARVIS DB and calls `ShellFallbackCollector.ingest`;
- rejects ORCA-present events, secrets/keypress/password/private reasoning, raw oversize output;
- supports idempotent replay and JSON status;
- provide opt-in zsh/bash hook templates and install/uninstall scripts; default disabled;
- do not capture stdin/keystrokes; ORCA remains preferred and duplicates are rejected.

## 5. Runtime/CLI/health/deployment integration

- Add CLI commands or executable scripts for agent MCP, daily loop, memory settlement, and shell ingest.
- Extend doctor/capability/status surfaces with these runtime components and provider profile health.
- Add user-systemd units with Node 24 absolute path/immutable release paths, `UMask=0077`, loopback-only listeners, restart policies, and writable-path allowlists.
- Correct `docs/personal-os/jarvis-joint-completion.json`: migration must be 034, deploy remains false until actual deployment, and only verified counts may be written.
- Update operator docs with exact commands, failure modes, rollback, and no unauthorized activation.

## Verification gates

Use TDD. Run focused tests, then:
`PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:$PATH npm run verify`
Also run protocol/process smokes for each new executable. Migration 033 checksum must remain exactly HEAD and full progress-lock subprocess test must pass. No commit/push/deploy. Write exact completion evidence under `.omo/evidence/joint-runtime-wiring.{md,json}`; do not claim complete with any listed wiring missing.
