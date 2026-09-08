# Versioned work routing preview

Date: 2026-09-09. Backlog 20, prerequisite to executor registry 21.

The dev-wiki routing draft contains both first-match ordering and a more-specific
document exception. No running executor registry implements these rules. Introduce
a bounded, deterministic classification command before connecting dispatch.

`jarvis routing classify REQUEST.json POLICY.json` reads a version-1 request and an
explicit versioned JSON policy without opening AuthorityDb, probing agents or
dispatching work. The request contains an objective only. The policy carries a
policy ID, revision and ordered named rules with literal keywords and proposed
executor/record-store labels. Labels never become command strings or file paths.

The checked-in `config/work-routing.preview.json` is a preview of the four draft
categories. It is not installed policy or a change to dev-wiki's canonical rules.
Repository names are explicit configured aliases, not filesystem discovery. Update
the canonical routing ADR before enabling a precedence rule in production.

Exactly one matching rule is classified. Multiple matches return `needs_review`
with all matches; no match also requires review. No probabilistic confidence is
invented from literal matches. ASCII alphanumeric terms use word boundaries;
only ASCII A-Z are compared case-insensitively. Other NFC characters, including
Korean and Greek, use exact literal substring matching without case folding.
This is not intent/negation understanding: classification is advisory and
every result has executable=false and readiness=not_probed.

Results bind request and policy digests plus a deterministic decision digest, and
explain matching rule IDs and configured terms without echoing the objective.
Policy revisions, targets and rules participate in the digest. Closed schemas,
unique IDs/terms, bounded lists and strings reject malformed input. Both CLI files
are bounded regular files, opened nonblocking without following a final symlink.

HTTP task admission, approval-bound routing, executor readiness/registry, actual
mail/Sangfor/Cowork dispatch and result recording remain required follow-up work.
This preview must not be relabeled as successful agent selection or execution.

## Validation

Initial backend build, lint and all three typechecks exited 0. Four test files passed 30
tests in 3.76 seconds, covering category/conflict/no-match decisions, deterministic
digests, malformed policies/requests, compiled CLI with no database, bounded file
handling, existing help behavior and module reviewability.

Six additional compiled CLI processes (1154842, 1154869, 1154882, 1154893, 1154912,
1154927) classified code/mail/Sangfor/document examples, held `Sangfor 견적서` as
two matches, and held an unmatched schedule request. Every process exited 0;
the isolated JARVIS_DB path and directory inventory showed zero database files.
Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/routing-live-XbRqZE/receipt.json`.
These are actual CLI invocations with example requests, not actual agent dispatch.

Example request: `{"schema_version":1,"objective":"Sangfor 견적서"}`. Run with:

```sh
node dist/src/cli.js routing classify /absolute/path/request.json config/work-routing.preview.json
```

The expected result is needs_review with sangfor/document matches and executable=false.

The first independent review requested a fix for context-sensitive Unicode
lowercasing: uppercase Greek keyword `ΟΣ` was missed inside `ΟΣΑ`. A regression
test failed before the fix (1 failed / 19 passed). Matching and duplicate detection
now fold ASCII only, with the non-ASCII literal contract above. Final four-file
checks passed 31 tests in 4.00 seconds, and backend build/lint/three typechecks
exited 0. Compiled CLI processes 1193842 and 1193915 respectively classified `ΟΣΑ`
and returned needs_review for lowercase `οσα`, both exit 0 with zero DB files.
Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/routing-literal-PteaH6/receipt.json`.
