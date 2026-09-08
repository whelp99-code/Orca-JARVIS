# Approved task templates on the existing execution engine

Date: 2026-09-09. Backlog 24. Design and implementation sequence; templates are
not yet implemented or accepted. First targets are JARVIS/Second Brain operations.

## Three initial templates

| ID | Result | Machine-enforced scope | Completion and stop conditions |
| --- | --- | --- | --- |
| code-fix@1 | Verified code-change commit | Explicit source/read and write paths; approved checks | Required checks and independent verification pass; stop on changed input, missing source, authority loss or failed checks |
| incident-report@1 | Structured diagnosis report in a result commit | One report output; supplied evidence files read-only | Validate report structure and references against supplied files; separate observations, hypotheses, proposed actions and limitations; no claim that the incident is resolved |
| technical-review@1 | Structured technical review in a result commit | One report output; supplied project files read-only | Validate findings/recommendations/limitations and source references; mark semantic conclusions for review; do not modify reviewed sources |

These produce repository artifacts through the existing candidate/verifier/Git
publication/completion path. Live service remediation, email sending, Sangfor
changes and automatic memory promotion are outside their authority. A report
format check is not proof of technical truth or permission to perform its actions.

## Binding and execution requirements

1. Keep versioned compiled definitions with a digest of the complete definition.
   Unknown versions fail closed; do not reinterpret an approved old revision with
   new rules. Preserve old definitions while referenced by existing tasks.
2. Store a structured template binding in the original workflow input: ID,
   revision/definition digest, source paths, writable paths and mandatory checks.
   Resolve the template requirements into TaskSpec before computing its digest.
   Do not encode machine rules only as natural-language constraint strings.
3. Reuse `stageDashboardTask` and the existing proposal/budget/deadline validation
   for workflow-start approval. Template metadata must be produced and included
   before staging, not appended to an already signed or completed command.
4. `assertTaskExecutionBinding` already compares current workflow input and budget
   against the completed, approved workflow.start input. Extend its validation for
   template bindings and enforce template file/check restrictions before plan
   preparation, staging and execution. Checking only a template-specific UI would
   let generic `control plan-task` bypass those restrictions.
5. Report templates generate fixed structural/source-reference verification
   commands. Treat paths and report data as values, never interpolated executable
   source. User-supplied checks may add requirements but cannot replace mandatory
   checks or widen the template's writable file set.
6. Use the existing plan preparation to capture current repository identity,
   baseline and file hashes. A plan's declared paths and checks must agree with
   the approved template binding. A change requires a new reviewed plan/request.
7. Preserve existing independent verifier, single-use approval, timeout/fence,
   uncertainty and replay semantics. Derive template identity for result displays
   from the bound workflow; do not rewrite historical completion receipts.

## Acceptance before declaring templates executable

- Run all three templates through workflow-start approval, plan preparation,
  execution approval, candidate generation, independent verification, result
  commit and completion lookup. Distinguish fixture transports from actual model
  acceptance. At least one final acceptance uses the installed real provider.
- Attempt writable-source substitution, missing mandatory checks, edited template
  metadata, unknown revision and generic CLI bypass: reject before invocation.
- Report tests include invented/foreign source references and empty required
  sections. Report success certifies the artifact/checks, not incident resolution.
- Replay each completed request: provider/verifier/ref mutations remain zero.
  Test cancellation and expired approval after asynchronous preparation.
- Source privacy bindings for memory-derived input remain a separate required
  boundary in `task-memory-source-privacy-hold.md`; do not enable automatic memory
  ingestion or output promotion through templates as a workaround.

## Preparation prerequisite found during discovery

The dashboard preparation service still held separate 4MiB/16MiB literals and a
Claude-only comparison. Its blob reads and aggregate checks now use shared
`TASK_FILE_LIMITS`; repeated registration checks use `assertRegisteredTaskPlan`.
That helper assumes an already structurally parsed plan. The public offline and
runtime parser still parses first. This avoids reparsing the complete manifest
between each file read while sharing the compiled executor registration policy.

This prerequisite does not constitute completion of backlog 24. Template catalog,
workflow binding, generic-path enforcement and all three execution acceptances
remain implementation work.

Prerequisite verification on 2026-09-09: backend build, 34 integration tests in
four files (22.12s), lint and all three TypeScript configurations exited 0
(process handle81293). The tests cover dashboard HTTP approval/execution/durable
completion with fixture providers, unsupported-provider rejection before Git,
blob/aggregate limits, cancellation and stale baselines; offline validation also
runs the built CLI in a separate process. This is local integration verification,
not real-model template acceptance or production activation. The extracted
registration assertion retains the parser's narrowed V2 return type.
