# Pre-GJC shadow gate

This is a local, read-only boundary. It has no GJC importer, queue, API client, or dispatch capability.

Run the release gate with:

```sh
npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z
```

Success emits exactly one JSON line declaring `pre_gjc_ready`, `stopped`, promoted completion, and `gjc_dispatched:false`. Any malformed, stale, expired, unsigned, replayed, ambiguous, incomplete, or authority-blocked input emits `E_SIGNAL_FAIL_CLOSED` on stderr, emits nothing on stdout, and exits 1.

The fixture contains one or more targets. Each target binds the provider, terminal, incarnation, cursor, structured Ed25519 ProgressSignals, provider/purpose-scoped trusted keys, all six independently signed evidence kinds (`focused`, `integration`, `crash_replay`, `cli`, `full`, and `node24`), and a fresh signed `census` proof. Terminal prose is neither parsed nor used as status or completion evidence.

Migration `010_pre_gjc_shadow.sql` persists immutable progress key registrations and revocations, FIFO candidates with leases/fences/retries, scheduler budgets and pause state, report outbox metadata, exact authority requests, completion evidence, proposal-only improvement records, and a boundary audit constrained to `gjc_dispatched=0`.

## Live local supervisor

Migrations `011_live_supervisor.sql` and `013_live_runtime_binding.sql` add a durable registry of one to five
canonical worktrees and exact Codex/Claude terminal, session, and incarnation
bindings. Registration cannot silently replace an active binding. The local
supervisor drains an unacknowledged consolidated report before new Orca reads,
then advances all cursors atomically and emits one sorted, change-only report.
Read-only terminal output is never interpreted as status; without a verified
structured provider signal it is classified as `unknown` and creates no resume
authority or terminal input.

```sh
jarvis db migrate --db shadow.sqlite
jarvis project register binding.json --db shadow.sqlite
jarvis project list --db shadow.sqlite
jarvis supervisor once --db shadow.sqlite
jarvis supervisor watch --interval-ms 10000 --db shadow.sqlite
jarvis report status --db shadow.sqlite
jarvis approval list --db shadow.sqlite
jarvis capabilities --json --db shadow.sqlite
```

`supervisor watch` runs continuously at the configured ten-second interval and
prints only report-bearing cycles. `--once` is a deterministic test/host probe.
When the durable per-project live-resume policy is enabled, both cycle modes
also deliver pending canonical human intents and policy-only stopped intents.
The policy ledger never synthesizes a human receipt: it binds the immutable
enable revision/digest, trusted fresh signed signal, staged candidate fence,
budget, rate limit, completion state, and exact runtime binding. Every failed
revalidation is durably blocked; a `sending` crash is never replayed.

`resume deliver <intent>` is the only opt-in terminal mutation. Live resume is
durably configured per registered project, not by a transient CLI flag. It
revalidates the signed logical session plus the separate Orca runtime binding
(`handle`, `ptyId`, `incarnationId`, `worktreeId`, `connected`, `writable`) and
uses public argv-based `orca terminal show` followed by `orca terminal send`. Its persisted attempt
ledger stores only prompt and response digests. A send error or a crash after
the `sending` marker becomes human-review `uncertain`/blocked and is never
blindly replayed. The default capability output reports `live_resume:false`.
