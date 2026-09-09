# Per-task routing bound to approval and execution

2026-09-09, backlog20/21. Previously routing classification returned a preview,
but its policy and selected executor did not survive into the approved TaskSpec.

`POST /api/v1/tasks` now accepts optional `routing` alongside the existing task
fields. This is an explicit per-task proposal, not a new installed routing policy:

```json
{
  "schema_version": 1,
  "policy": {
    "schema_version": 1,
    "policy_id": "code-work",
    "revision": 1,
    "rules": [{
      "id": "code", "keywords": ["Fix"],
      "executor_ids": ["claude-code"], "record_stores": ["second-brain"]
    }]
  },
  "decision_digest": "<decision_digest from routing classify for the exact objective and policy>",
  "executor_id": "claude-code"
}
```

Recompute classification at input validation and again against the planned
objective. Require exactly one matched rule, its decision digest, and explicit
selection from that rule's executor IDs. No-match/ambiguous cases return409
`TASK_ROUTING_REVIEW_REQUIRED`; invalid/stale bindings return400
`TASK_ROUTING_BINDING_INVALID`. An unregistered selection returns409
`TASK_EXECUTOR_UNREGISTERED`. Registration is not an authentication/readiness claim.
Existing input bounds, Origin/CSRF and human approval still apply.

The normalized policy, selected ID and decision digest become `TaskSpec.routing`.
The complete TaskSpec digest, therefore execution-plan and approval digests,
change when routing changes. The original workflow.start command records that
input for independent rechecking. Every `assertTaskExecutionBinding` rechecks
the classification through workflow validation and matches the plan provider's
compiled registry ID to the approved selection. A different provider fails with
`TASK_ROUTING_EXECUTOR_MISMATCH` before staging and in existing execution preflights.
No policy label can select an executable path or dynamically register an adapter.

Existing TaskSpecs without routing retain their exact previous shape/digest and
execution behavior. New routed records require this reader on rollback; older
strict readers cannot be assumed to accept the extension. No persisted migration
bytes or schema are changed. The extension follows the existing optional template
input approach and is validated wherever the approved TaskSpec is validated.

Record-store labels remain proposals. They do not authorize Second Brain writes,
dev-wiki edits, external sends or mark those results delivered. Global routing
precedence/default policy from dev-wiki is unchanged. The frontend has no new
policy-editing controls in this unit; API callers can submit the explicit proposal.
Automatic policy selection, other registered executors, result-store lifecycle,
operational activation and the full01–25 objective remain incomplete.

## Validation

- Initial74704:48 passed/1failed. Failure was the pre-existing544-character secret
  regex in contracts.ts entering the changed-file reviewability gate. Type-import
  adjustment alone did not resolve it (52423:4pass/1fail). Kept the extension in
  the API parser/service type, as with templates, and restored contracts.ts to HEAD.
  Lint79297 also found an unused test binding, now explicitly asserted.
- Final31305: backend build and49tests/6files29.93s passed, covering HTTP creation,
  routed completion/replay, provider mismatch/no-write behavior, existing task
  preparation/execution, TaskSpec, historical routing report and reviewability.
  Final lint/three typechecks34002 exited0. Additional completion regressions79767
  passed73tests/5files47.92s; combined122tests/11files.
- Actual78083 exited0: installed Claude provider1, independent verifier1,
  completed result commit `a6210f19f8c4babcf23b91bffb0b7303bb8cc5ea`, elapsed42490ms.
  Original HEAD/status and source preserved, replay added no provider/verifier
  calls or Git ref changes. Separate compiled performance CLI verified completion1.
  Per-task routing decision and TaskSpec digest persisted. Receipt:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/routed-task-real-wb0qqD/receipt.json`.
  Final subsequent source edits were type annotations/imports only; functional
  behavior was unchanged. Fixture DB/Git and test signing key were cleaned.
- Runtime static graph:611modules/2223edges/cycles0. No production DB, deployment,
  service restart or policy installation. Independent acceptance pending.

- Independent approved_routing_review returned ship/findings0. Parent verified
  11/11 packet hashes before acceptance; requested terra/high, actual metadata
  unavailable. No product changes after final checks. Accepted for bounded commit.
