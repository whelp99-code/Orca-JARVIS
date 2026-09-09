# Retain only the requested timeline tail

The timeline previously retained every projected event payload before sorting and
slicing. Keep a sorted tail of at most ceil(clamped limit) projected events for a
finite limit, inserting after equal comparator keys to preserve stable sort order.
Remember every encountered event ID even when its payload leaves the tail: later
duplicates must never replace the first emission. Collectors and privacy checks
are unchanged. Preserve original slice arithmetic using the full distinct count,
including fractional limits, floating-point rounding and the legacy NaN behavior.

This bounds retained projected event count, not total memory or payload bytes.
Collectors still hold raw rows and graph/ID sets grow with the input. NaN retains
all events as before. A streaming collector or an explicit input-policy change
requires separate work; neither is claimed delivered here.

## Verification

- Final lint, typecheck, backend build exit 0; five related files / 22 tests pass.
- New SQLite regression covers 602 events, chronological ties, limits 1/2/200/500,
  fractional limits, 1 + Number.EPSILON, NaN, and an evicted first occurrence whose
  later duplicate would otherwise replace the winner. A second regression caught
  the draft's incorrect boundary treatment of distinct Unicode IDs that compare
  equal. It failed before the strict-less-than correction and passed afterwards.
- Dense synthetic DB: 1,000 parents with 100 child events each, 1,035-byte JSON
  payloads. Final compiled library: 569.70 ms, max RSS 396,124 KiB, 200 events,
  0 writes, identical output SHA to the prior collector:
  cc8a50fb51c3a2fb36c20c47b885528ca10dacfeaca11f651c6f3062ba564fa6.
  Prior local sample: 638.82 ms / 467,668 KiB. Single samples, not an SLO or
  controlled production performance estimate.
- Actual compiled CLI: exit 0, 807.82 ms, 71,316 stdout bytes, 0 stderr bytes;
  independently open SQLite connection observed unchanged data_version.
- QA: /home/jm/.cache/jarvis-test-runtime-qa-20260908/top-k-final-tests.log and
  timeline-batch-compare-8FpTMB/top-k-product-receipt.json under the same QA root.
- The prior 3,791-test canonical gate predates this change. This change has targeted
  acceptance only; no production activation. Independent native review: ship, no findings.

## Independent acceptance

Native reviewer `/root/timeline_tail_review` returned ship with no findings after
checking first-emission deduplication, stable comparator ties and original slice
conversion. Requested gpt-5.6-sol/high; observed model/effort metadata unavailable.
The reviewer confirmed the input-sized raw rows, graph/ID sets and NaN exception
remain. CodeRabbit was not used for acceptance: its authentication attempt was
stopped (exit 130); the final verdict is the native local-source review.

API-equivalent cost receipt unavailable: no observed token usage for parent or
reviewer was provided by native tools; no cost or savings estimate is claimed.
