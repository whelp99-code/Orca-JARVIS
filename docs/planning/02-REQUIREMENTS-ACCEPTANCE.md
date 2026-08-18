# Requirements and Acceptance

## REQ-CAP-001 — Typed capability matrix

- Priority: P1
- Mandatory: MUST
- Actor: operator or proposal planner
- Trigger: `runDoctor`, `capabilities --json`, or direct library call
- Precondition: migrated database; injected probe implementation
- Input: current database state, executable/version probe results, timestamp
- Input validation: capability IDs and evidence strings are non-empty; protocol versions are parsed before compatibility is true
- Authorization: read-only; no receipt required
- Processing: evaluate each capability independently across `installed`, `configured`, `protocol_compatible`, `operational`, and `authorized`
- Output: `CapabilityMatrixV1`
- State change: none
- Side effects: injected read-only probes only
- Failure conditions: probe failure produces a false state with evidence; it does not throw unless the matrix input is structurally invalid
- Performance target: complete within 2 seconds under injected unit probes
- Security target: no credential value, token, environment secret, or raw auth header in evidence
- Excluded behavior: package installation, login, config mutation, provider invocation
- Dependencies: existing `DoctorReport`, `AuthorityDb.gjcOperational`, `LiveSupervisor.liveResumeConfigured`

### Acceptance

- `ACCEPT-CAP-001-A`: Given installed and protocol-compatible GJC with operational DB configuration, when the matrix is built, then GJC states report true with evidence and no database row changes occur.
- `ACCEPT-CAP-001-B`: Given a missing executable or incompatible protocol, when the matrix is built, then the affected state is false, later states cannot be true, and the result contains a non-secret reason.
- `ACCEPT-CAP-001-C`: Given existing consumers of `capabilities --json`, when the command runs, then existing flat fields remain and `matrix.schema_version` equals `1`.

## REQ-TEAM-001 — Proposal-only archetypes and bounded interview

- Priority: P1
- Mandatory: MUST
- Actor: operator or planning client
- Trigger: `team propose <request.json>` or direct library call
- Precondition: valid `CapabilityMatrixV1`
- Input: `objective`, optional `work_type`, optional answers, constraints, and capability matrix
- Input validation: objective 1–4,096 UTF-8 bytes; 0–3 answers; supported work type; no unknown keys
- Authorization: read-only; no receipt required
- Processing: return missing-information questions when required fields are absent; otherwise select bounded archetypes and attach scope, exclusions, and verification duties
- Output: `TeamProposalResultV1`
- State change: none
- Side effects: none
- Failure conditions: invalid input returns `TEAM_PROPOSAL_INPUT_INVALID`; impossible capability requirement returns `status="blocked"` with factual reasons
- Performance target: deterministic completion under 100 ms
- Security target: no prompt execution, shell call, terminal send, worker spawn, credential read, or authority grant
- Excluded behavior: persistence, auto-retry, team replacement, model invocation, CLI adapter execution
- Dependencies: REQ-CAP-001

### Acceptance

- `ACCEPT-TEAM-001-A`: Given an objective missing work type and completion evidence, when proposal planning runs, then it returns 2–3 deterministic questions and no members.
- `ACCEPT-TEAM-001-B`: Given complete input and operational authorized capabilities, when planning runs twice, then canonical output and proposal digest are identical and every member has one archetype, scope, exclusions, and verification duty.
- `ACCEPT-TEAM-001-C`: Given a requested provider that is not operational or authorized, when planning runs, then status is `blocked`, no worker is created, and reasons reference capability IDs.
- `ACCEPT-TEAM-001-D`: Given arbitrary prose containing command text, when planning runs, then no command, model, terminal, or database mutation occurs.

## REQ-EVID-001 — Immutable typed negative evidence

- Priority: P1
- Mandatory: MUST
- Actor: approved command executor
- Trigger: approved `evidence.negative.record` control command
- Precondition: migrated database, claimed unexpired receipt, action level 2
- Input: task ID, attempt ID, reason code, bounded scope list, summary, evidence digest
- Input validation: exact keys; NFC strings; bounded byte lengths; `sha256:` digest; supported reason code; action level exactly 2
- Authorization: authenticated one-use control receipt bound to the command digest
- Processing: derive deterministic evidence ID, insert one immutable row, emit existing control audit result
- Output: evidence ID and canonical payload digest
- State change: append one `negative_evidence` row
- Side effects: timeline and current-state reads expose the row; no Markdown write occurs during recording
- Failure conditions: invalid input, missing receipt, expired fence, duplicate ID with different payload, unknown task binding
- Performance target: insert and timeline visibility under 100 ms in local SQLite tests
- Security target: no stack trace, secret, raw command output, or unrestricted prose; summary max 1,024 UTF-8 bytes
- Excluded behavior: row update/delete, automatic retry, team replacement, task completion/failure mutation
- Dependencies: existing control receipts, canonicalization, task timeline, state projection

### Acceptance

- `ACCEPT-EVID-001-A`: Given a valid approved command, when execution runs, then one immutable row is inserted and the timeline references its evidence digest.
- `ACCEPT-EVID-001-B`: Given no receipt, expired fencing, wrong action level, invalid digest, or unsupported reason, when execution runs, then no row is inserted and the existing safe error envelope is returned.
- `ACCEPT-EVID-001-C`: Given the same approved command is replayed, when execution runs, then the existing idempotent result is returned or replay is rejected without a second row.
- `ACCEPT-EVID-001-D`: Given negative evidence exists, when current-state Markdown is generated, then it appears only as derived projection and direct writes to retired collaboration tables remain rejected.

