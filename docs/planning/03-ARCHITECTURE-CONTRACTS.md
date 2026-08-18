# Architecture and Contracts

## Current architecture

SQLite authority state feeds approved execution, workflow transitions, task timeline, and generated current-state projections. CLI capability reporting is currently an inline flat object.

## Target architecture

```text
Injected executable/version probes ─┐
Database operational state ─────────┼─> CapabilityMatrixV1 (read-only)
Live resume configuration ──────────┘             │
                                                   └─> proposal planner (no authority)
Approved control receipt ─> ApprovedCommandExecutor ─> immutable negative evidence
                                                        │
                                                        ├─> TaskTimeline
                                                        └─> current-state projection
```

## ADR-001 — Capability facts are typed and monotonic

- Status: ACCEPTED
- Date: 2026-08-18
- Related: REQ-CAP-001, PR-001
- Context: command presence alone does not prove readiness.
- Options: flat booleans; one generic availability flag; staged capability facts.
- Decision: use five ordered facts per capability.
- Reason: distinguishes installation, configuration, compatibility, runtime health, and authority.
- Consequence: callers can explain why a provider is unavailable.
- Rollback: retain existing flat fields and remove only `matrix`.

## ADR-002 — Team composition is proposal-only

- Status: ACCEPTED
- Date: 2026-08-18
- Related: REQ-TEAM-001, PR-002
- Context: archetypes improve decomposition, but agent prose is not authority.
- Options: direct spawning; persisted team runtime; ephemeral structured proposal.
- Decision: emit deterministic proposals with no persistence or execution.
- Reason: preserves approval receipts, fencing, and external-effect uncertainty boundaries.
- Consequence: another approved workflow must consume any accepted proposal.
- Rollback: remove `team propose` and the read-only export.

## ADR-003 — Negative evidence is authority data, Markdown is projection

- Status: ACCEPTED
- Date: 2026-08-18
- Related: REQ-EVID-001, PR-003
- Context: dead ends improve recovery, but shared mutable Markdown would conflict with the retired collaboration workspace.
- Options: shared Markdown; reuse generic event prose; immutable typed SQLite ledger.
- Decision: append typed negative evidence only through approved execution and project it through existing readers.
- Reason: preserves receipts, replay protection, auditability, and one authority store.
- Consequence: one forward migration and timeline/state-projection extensions are required.
- Rollback: stop issuing the action and hide the projection; immutable historical rows remain.

## Capability contract

```ts
export type CapabilityStage =
  | "installed"
  | "configured"
  | "protocol_compatible"
  | "operational"
  | "authorized";

export interface CapabilityStageResult {
  ok: boolean;
  evidence: string;
}

export interface CapabilityFact {
  id: "codex" | "claude" | "orca_read" | "gjc" | "live_resume";
  stages: Record<CapabilityStage, CapabilityStageResult>;
}

export interface CapabilityMatrixV1 {
  schema_version: 1;
  checked_at: string;
  capabilities: CapabilityFact[];
}

export interface CapabilityProbe {
  inspect(id: CapabilityFact["id"]): Promise<{
    installed: { ok: boolean; version: string | null; evidence: string };
    configured: { ok: boolean; evidence: string };
    protocol_compatible: { ok: boolean; protocol_version: string | null; evidence: string };
    operational: { ok: boolean; evidence: string };
    authorized: { ok: boolean; evidence: string };
  }>;
}

export function buildCapabilityMatrix(
  db: AuthorityDb,
  probe: CapabilityProbe,
  now?: Date,
): Promise<CapabilityMatrixV1>;
```

### Invariants

- A true stage requires every earlier stage to be true.
- Evidence is bounded to 512 UTF-8 bytes and passes secret redaction.
- Capability construction performs no writes.
- Unit tests inject probes; they do not inspect the developer workstation.

## Team proposal contract

```ts
export type TeamArchetype =
  | "leader"
  | "researcher"
  | "analyst"
  | "builder"
  | "writer"
  | "designer"
  | "critic";

export interface TeamProposalRequestV1 {
  schema_version: 1;
  objective: string;
  work_type?: "research" | "development" | "analysis" | "content" | "product";
  completion_evidence?: ReadonlyArray<string>;
  answers?: ReadonlyArray<{ question_id: string; answer: string }>;
  constraints?: ReadonlyArray<string>;
  requested_capabilities?: ReadonlyArray<CapabilityFact["id"]>;
}

export type TeamProposalResultV1 =
  | { schema_version: 1; status: "needs_input"; questions: ReadonlyArray<{ id: string; text: string; required: true }> }
  | { schema_version: 1; status: "blocked"; reasons: ReadonlyArray<{ capability_id: string; stage: CapabilityStage }> }
  | { schema_version: 1; status: "ready"; proposal_digest: string; objective: string; members: ReadonlyArray<TeamMemberProposal> };

export interface TeamMemberProposal {
  member_id: string;
  archetype: TeamArchetype;
  role: string;
  scope: ReadonlyArray<string>;
  exclusions: ReadonlyArray<string>;
  verification: ReadonlyArray<string>;
  preferred_capability_ids: ReadonlyArray<CapabilityFact["id"]>;
}

export function planTeamProposal(
  input: TeamProposalRequestV1,
  matrix: CapabilityMatrixV1,
): TeamProposalResultV1;
```

### Proposal invariants

- At most five proposed members; exactly one leader when status is `ready`.
- Every non-leader member has one archetype and disjoint primary scope.
- Questions are selected from a fixed registry and total 2–3.
- A ready result requires non-empty `completion_evidence`; otherwise the fixed registry asks for it.
- Proposal digest uses canonical JSON and excludes timestamps.
- Ready/blocked/needs-input output is not stored and cannot be used as an approval receipt.

## Negative-evidence contract

```ts
type NegativeEvidenceReason =
  | "invalid_assumption"
  | "failed_approach"
  | "blocked_dependency"
  | "verification_failure"
  | "external_uncertain";

interface NegativeEvidenceInputV1 {
  schema_version: 1;
  task_id: string;
  attempt_id: string;
  reason_code: NegativeEvidenceReason;
  scope: readonly string[];
  summary: string;
  evidence_digest: `sha256:${string}`;
}

interface StoredNegativeEvidence {
  evidence_id: string;
  task_id: string;
  attempt_id: string;
  reason_code: NegativeEvidenceReason;
  scope: readonly string[];
  summary: string;
  evidence_digest: string;
  request_id: string;
  receipt_id: string;
  created_at: string;
}
```

### Data contract

Table `negative_evidence`:

| Column | Contract |
|---|---|
| `evidence_id TEXT PRIMARY KEY` | deterministic digest ID |
| `task_id TEXT NOT NULL` | timeline correlation |
| `attempt_id TEXT NOT NULL` | failed attempt identity |
| `reason_code TEXT NOT NULL` | CHECK against five reason values |
| `scope_json TEXT NOT NULL` | canonical JSON array, 1–20 entries |
| `summary TEXT NOT NULL` | NFC, 1–1,024 UTF-8 bytes |
| `evidence_digest TEXT NOT NULL` | `sha256:` evidence reference |
| `request_id TEXT NOT NULL UNIQUE` | FK to control request |
| `receipt_id TEXT NOT NULL UNIQUE` | FK to control receipt |
| `created_at TEXT NOT NULL` | RFC3339 milliseconds |

Indexes: `(task_id,created_at,evidence_id)` and `(reason_code,created_at,evidence_id)`.
Triggers reject every update and delete.

### State and error contract

- `evidence.negative.record` is action level 2.
- Allowed transition: absent → recorded.
- Duplicate same request: existing executor idempotency behavior.
- Duplicate identity with different payload: `NEGATIVE_EVIDENCE_REPLAY_CONFLICT`.
- Invalid shape: `NEGATIVE_EVIDENCE_INPUT_INVALID`.
- Missing/expired authority: existing control receipt/fence errors.
- Recording does not change workflow or task terminal state.

## Other contracts

- Data: N/A for REQ-CAP-001 and REQ-TEAM-001; REQ-EVID-001 uses the table above.
- API: CLI JSON and exported TypeScript interfaces only; no network API.
- UI: N/A — no browser or terminal UI layout change.
- Events: capability and proposal reads emit none; negative evidence appears through existing control and timeline projections.

