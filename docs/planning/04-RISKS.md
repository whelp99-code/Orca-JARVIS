# Risks

Risk score = Probability × Impact × Detectability.

| ID | Risk | P | I | D | Score | Level | Prevention | Recovery |
|---|---|---:|---:|---:|---:|---|---|---|
| R-001 | Host-specific tests become nondeterministic | 3 | 3 | 3 | 27 | R2 | Inject every executable/version probe | Replace direct host calls with fixtures |
| R-002 | Capability evidence leaks credentials | 2 | 5 | 4 | 40 | R3 | Fixed evidence vocabulary, redaction, 512-byte bound | Disable matrix field; retain flat output |
| R-003 | Existing capability consumers break | 2 | 4 | 2 | 16 | R2 | Preserve every current flat field | Remove nested matrix |
| R-004 | Archetypes over-specialize a small task | 3 | 2 | 2 | 12 | R1 | Cap members at five and prefer the smallest sufficient team | Return a one-member proposal |
| R-005 | Proposal is mistaken for authorization | 2 | 5 | 4 | 40 | R3 | No persistence or execution API; explicit proposal status and digest domain | Remove CLI command/export |
| R-006 | Negative evidence becomes a second mutable collaboration store | 2 | 5 | 4 | 40 | R3 | Immutable typed rows; no direct public writer; projection-only Markdown | Disable action/projection, retain audit rows |
| R-007 | Migration fails or shipped migration bytes change | 2 | 5 | 2 | 20 | R2 | Add only migration 028; checksum tests for prior files | Restore prior bytes and re-run migration tests |
| R-008 | Sensitive command output enters summary | 3 | 4 | 3 | 36 | R3 | Bounded summary, secret-pattern rejection/redaction, evidence by digest | Reject insert and require sanitized resubmission |

## R3 failure mode — evidence leakage

- Trigger: probe returns stderr or configuration text containing a secret.
- Failure: secret is serialized into CLI or doctor output.
- Detection: tests inject token-shaped values and assert redaction; review scans JSON fixtures.
- Recovery: return `evidence="redacted_probe_failure"` and disable free-form probe evidence.

## R3 failure mode — proposal treated as authority

- Trigger: downstream caller passes a proposal digest where a control receipt is required.
- Failure: work executes without authenticated approval.
- Detection: executor tests submit proposal digests and require `WORKFLOW_APPROVAL_RECEIPT_REQUIRED` or the existing equivalent.
- Recovery: reject the transition; no state or external effect may be committed.

## R3 failure mode — negative-evidence authority bypass

- Trigger: code calls the ledger directly without a claimed receipt.
- Failure: untrusted prose becomes authoritative history.
- Detection: root export test rejects the recorder; integration test proves only `ApprovedCommandExecutor` inserts.
- Recovery: remove the direct export/caller and reject unbound rows by FK/UNIQUE constraints.

## R3 failure mode — sensitive summary

- Trigger: caller submits token-shaped or authorization-shaped text.
- Failure: projection exposes secret material.
- Detection: integration fixtures submit secret patterns and expect no inserted row.
- Recovery: return `NEGATIVE_EVIDENCE_INPUT_INVALID`; caller resubmits a sanitized summary and digest reference.

## Required security review

- Authentication bypass: N/A — read-only capability output.
- Authorization elevation: prohibited; matrix cannot grant authority.
- Injection: probe uses `spawn` with `shell:false` or an injected implementation.
- Secret exposure: R-002.
- Concurrency: no state mutation.
- Migration failure: PR-003 adds only migration 028 and preserves bytes 001–027.

