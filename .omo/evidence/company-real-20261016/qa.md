# JARVIS company freshness and daily report QA

Task: TASK-JARVIS-FRESHNESS-CONFIG-B-20261016
Attempt: 9db9d7be-c7aa-4b66-9b12-b00545bbfeed

This is a working evidence ledger, not the final requested delivery file.

## Real cross-repository surface

The existing Unix brokers invoked the **actual SB CLI main**, authority verifier,
company DB provider, original receipts and SQL effects. Only the explicit test
provider dependency uses a persistent simulated NV anchor. The automatic fixture
also pins its policy key inside its private scratch directory. No operating
registry, DB, service, TPM, or policy credential was touched. This is not physical
TPM provisioning or production readiness evidence.

Human integration used SB PR84 product at
ca2292180e1f7367d5323a4b7f051ac237114fb1. SB subsequently advanced to
6e56964b34e9b2e092ddf5152bf09a89b2f2267f with positive classifier allowlisting.
The lead reran the real automatic broker/SQL/report integration on that newer
head with a fresh scratch DB: PASS. Wire/provider files were unchanged.
`latest-sb-auto-readback.json` preserves the new original receipts, report
43ef65a8, unchanged3 safe SQL effects, protected2 effects0, and report replay.
JARVIS is stacked on PR93 head72f6da8510516af01eb8867ad2f68b391efa654e.

Final remote readback found SB84 at4e2d569fa34367ad9238f80f4dc73c5e65847667,
an additive cancellation increment after the tested6e56964. This ledger pins
the actual tested versions above; it does not claim testing that later
cancellation work or its compatibility. All prerequisite PRs remain OPEN.

### Human approve, completion and replay

Actual SB readback:

| Store | Operation | State | Count |
|---|---|---|---:|
| JARVIS | decide_approve | finished | 1 |
| JARVIS | complete | finished | 1 |
| SB | accept | finished | 1 |
| SB | mark_processed | finished | 1 |

Original accept receipt:
`cmreceipt:v1:8280d93620c95f4b107d28336de648453f3b7b2b4de3066d4133a70414c7fec6`
at2026-10-16T05:12:42.905Z. Original processed receipt:
`cmreceipt:v1:622f720254ba6e880869edbdd4c7a5956d5f20c7dd34f76abf9eba386275f3bd`
at2026-10-16T05:12:45.022Z. Repeated execute returned the same receipts.
The downstream verifier wrote and independently read back an actual file;
effect SHA256 was
`c4bc7be13b59dfbfae414086d30b80f318a9fa305598dbf7c90d08bf8f895826`.
Both immutable JARVIS evidence rows were acknowledged.

### Human rejection and replay

Actual SB readback was JARVIS decide_reject1 and SB reject1, both finished.
Repeated execution retained
`cmreceipt:v1:61c7dbbbde72bad9da25a2f140d5ef8c1c0b50fd882d4501b4c2b2c2a8c60463`
at2026-10-16T05:16:24.262Z. No completion effect was made.

Every simulated anchor read took an independent SQLite connection and acquired
BEGIN IMMEDIATE with timeout0, proving that the provider call was outside the
company effect writer. No busy_timeout increase was used.

### Automatic internal SQL and fixed report read

Two genuine signed trigger calls through the processor broker left exactly one
calendar, one contact and one progress SQL record. SB owned accept/complete/
mark_processed, with3 finished reservations for each operation. Protected money
and contract candidates produced0 effects.

The handoff broker's fixed read-only auto-report path produced:

```text
contact_new=1 calendar_memo=1 progress_memo=1 completed=3
human_required=2 conflict=2 unresolved=0
rows=5 fabricated_JARVIS_human_receipts=0 notification_intents=1
```

Conflict is a subset of human_required, matching SB's original aggregates.
Report ID:
`company-report:v1:84ce14ea077d2fc4f487dfa80f1984aff7ce75bac8d5b5f351595d5b88f9e425`.
The repeated fixed-clock publication returned created=false and the same ID.
Original completed references were:

- calendar: `cmreceipt:v1:7d9a1fed00917178413412ae5f60c83a0861770cbcea9d82b725310c51a6ec71`
- contact: `cmreceipt:v1:8c73dceb660c91e701e4121860ab204f15e76d38c34d3c14bef9e849730acfcc`
- progress: `cmreceipt:v1:f3361eb388076208729c3f598676da05d3ece8ff3ebd29ff37e927fcae96f750`

An initial test fixture incorrectly bootstrapped at08:00Z while the host was
at05:21Z; the adapter correctly refused cutoff_from>cutoff_to. The fixture was
rebuilt with a real, earlier bootstrap instant, not by rewriting immutable DB or
witness rows and not by weakening the adapter.

## Actual dashboard and notification surface

QA is synthetic metadata on an actual built dashboard and actual HTTP APIs, not
frontend response interception. The page contains a completed report, a0-row
report, and the original separately pending human candidate.

The browser clicked the real human approve action and observed HTTP200 from
`/api/v1/owner-inbox/challenge`. Navigation canceled the unavailable test-device
passkey step. DB readback remained pending1 and representative receipts0.
This proves the existing challenge route, not a completed human ceremony or a
real representative approval.

Actual claim/settle results:

| Case | HTTP | Durable result |
|---|---:|---|
| Client without company capability | 204 | Both company intents stayed queued |
| Capable client | 200 | company_daily_report payload and report deep link |
| Different authenticated recipient | 409 | NOTIFICATION_DELIVERY_STALE_LEASE |
| Unsupported native client | 200 | Delivery failed; report unsupported, retained |
| Next report delivered | 200 | Delivered with the original delivery ID |
| Exact duplicate settle | 200 | Same original terminal settlement |
| Another claim | 204 | No duplicate delivery |

Final report states were2026-10-16 delivered/completed3 and2026-10-15
unsupported/completed0. Notification processing never invoked the company effect
worker. macOS banner rendering itself was not run on this Linux workstation.

### Browser capture matrix

Routes: approvals, exact selected report, exact prior0-row report.
Each is captured at1440x900,1920x1080 and true iPhone14 emulation390x844/DPR3,
under light and dark preferences:18 captures. The shipped design is deliberately
dark-only, so each light/dark pair is byte-identical. PNG signatures and physical
dimensions were checked. All18 had document scrollWidth<=clientWidth and0
representative approval buttons inside automatic report cards.

Files follow `{approvals|report|empty}-{desktop-1440|desktop-1920|iphone-14}-{light|dark}.png`.
Lead inspected all9 unique light captures, all6 end-of-scroll captures, both
missing-report error captures, and the final mobile receipt capture. All pass:
no horizontal overflow, overlap, clipped report content or automatic approval
controls. The existing navigation scrolls independently on narrow screens.
Final screenshots include `receipt-final-mobile.png`,
`{approvals|report|empty}-{desktop-1440|iphone-14}-end.png` and
`error-{desktop-1440|iphone-14}.png`.

Observed mobile CJK syllable splitting was fixed with existing keep-all tokens.
The original operation ID stays in the technical evidence disclosure. The
receipt fragment was also corrected so URL-decoded fragments address the actual
DOM ID. The final mobile receipt target top167.8px is below the sticky header
bottom90.5px; the original ID and timestamps are visible in the disclosure.

### Manual daily-report CLI

`manual-report.mjs` exercised the actual compiled CLI parser and fixed broker
against the same real SB automatic fixture. An injected next-day clock permitted
the2026-10-17 report; create then replay returned the same84ce14ea report ID,
with reports1, intents1 and fabricated human receipts0. The default real clock
refused the future date. This was a scratch CLI test, not an operator backfill.

### Final QA matrix

| Scenario | Action / artifact | Observed | Verdict |
|---|---|---|---|
| Human approve/complete/replay | `human.mjs`, original receipts above | Four original owner reservations, file write/readback once | PASS |
| Human reject/replay | `human.mjs` reject scenario | Original reject receipt, effects0 | PASS |
| Internal auto + protected cases | `auto.mjs`, original report above | Three actual SQL effects, protected2 effects0, repeat unchanged | PASS |
| Daily CLI create/replay/future | `manual-report.mjs` | One report/intent, future refused | PASS |
| Approval/list/empty surfaces |18 paired route screenshots above | Metadata only, correct KST and counts, no overflow | PASS |
| Report bottom and error |8 end/error captures above | Human controls remain separate; retry error visible | PASS |
| Original receipt link | `receipt-final-mobile.png` | Target visible below header, original references preserved | PASS |
| Existing human challenge | Actual HTTP challenge + DB readback above |200, pending1, forged receipts0 | PASS |
| Notification compatibility/recipient/retry | Actual HTTP claim/settle table above | Correct pending, stale lease, unsupported and idempotent states | PASS |

## Checks

- Final company owner pack:19 files,284 tests PASS,70.32s.
- Final related card/owner-inbox pack:4 files,11 tests PASS,3.23s.
- Runtime, lint, architecture (cycles=[]), typecheck and both production builds
  passed again in the final complete canonical invocation on59a897c.
- Internal report/auto credentials now reject the handoff credential by ID and
  public material even without a configured freshness provider. Two new
  regressions failed before the fix, then the10-test integration owner suite,
  scoped lint and full typecheck passed (mon_XQXAM874JWR7JKDB, exit0).
- Earlier full verify found an import cycle; the factory and leaf wire contract
  were separated, preserving public exports. That failure is not PASS.
- A later full run was interrupted when real QA found final aggregation/CJK
  corrections. It is not PASS. The1800s deadline was unchanged in that attempt.
- Direct, non-canonical dashboard health tests exceeded their existing5000ms
  timeout, including an unchanged independent baseline. The canonical runner's
  isolated environment is the final full-suite evidence.
- A subsequent full attempt failed BACKEND_BUILD_SOURCE_CHANGED when the final
  whitespace correction and commit raced the source-pinning build. No test failed
  in that attempt, and it is not PASS. Subsequent invocations use immutable
  product commit59a897c95b934613e4f08463223df9c3d8891d91.

## Canonical deadline result

The frozen59a897c `npm run verify` hit its unchanged1800s deadline
(mon_0XRMZ8A1GK3ZH8XZ/bash_185, status timed_out, exit1). It is **not PASS**.
The first backend shard passed351 files/2524 tests in942.52s. The second shard
was still running when stopped; dashboard, fixed-clock acceptance and CLI smoke
were not reached in that invocation. Runtime, lint, architecture, typecheck and
both builds completed before the backend tests, as required by the `&&` chain.

`canonical-verify.log` is the captured terminal **tail**, not a complete log;
the terminal reports earlier output dropped. The first-shard summary above is
from its delivered completion event. Do not infer a complete-suite PASS from it.

The missing stages were initially attempted separately:

```sh
node scripts/run-tests.mjs backend --shard=2/2 --reporter=default --reporter=json --outputFile=.omo/evidence/company-real-20261016/backend-shard2.json
node scripts/run-tests.mjs dashboard --reporter=default --reporter=json --outputFile=.omo/evidence/company-real-20261016/dashboard-tests.json
npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z
node scripts/run-tests.mjs smoke
```

That complementary invocation used unchanged product59a897c and the existing
isolated runner (mon_ZHS07W424MNMA7DY). It was stopped when the user requested
a complete3600s retry. It is not claimed as PASS.

## Pending

Delivery-artifact recheck by the same single gate reviewer, non-draft READY PR
readback and cleanup.

### Explicit user-directed retry

After the1800s timeout the user authorized one full retry with a3600s outer
deadline, keeping individual test/runner limits unchanged. The complementary
partial run was stopped without claiming PASS. The exact canonical
`npm run verify` runs again on frozen59a897c. Git diff confirms no changes to
test runners/configs or product source. Only the monitor's outer deadline changed.
The original1800s run remains TIMED_OUT regardless of the new result.

## Final complete canonical result

**PASS, exit0**, mon_ZHB689TGVTNG1C2P/bash_194, frozen product59a897c.
The exact `npm run verify` completed runtime, lint, architecture, typecheck,
both builds, both backend shards, the entire dashboard suite, fixed-clock
acceptance and CLI smoke in the same invocation.

| Canonical stage | Files | Tests | Result |
|---|---:|---:|---|
| Backend shard1 |351|2524|PASS,1051.29s|
| Backend shard2 |351|2558|PASS,809.04s|
| Dashboard |61|439|PASS,54.40s|
| Total Vitest |763|5521|PASS|

Only the outer command deadline changed to3600s by explicit user instruction.
Individual test/runner limits, test bodies and product source stayed unchanged.
`verify-3600-metadata.md` preserves delivered summaries before terminal truncation;
`verify-final3600.log` is the bounded final tail and exit0, including acceptance
output. It is not falsely presented as a complete2276-line transcript.

Intervening failed attempts remain recorded: EDQUOT/write122 from11.4G abandoned
owned roots, then one unchanged memory test's5000ms timeout while another session
ran32 workers. Only owned abandoned roots were cleaned; the external session was
observed, not interrupted. The actual failing owners passed28tests after cleanup;
the exact memory file passed4tests after the observed external exit. No assertion
or timeout was weakened. Their logs remain separate from the successful run.

The passing dashboard suite emitted non-failing React `act(...)` warnings in
approvals-page and mail-candidates-route tests. They were not suppressed; this
task does not claim their pre-existing provenance or a warning-free UI suite.
