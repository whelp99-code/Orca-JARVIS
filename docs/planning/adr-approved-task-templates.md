# Approved task templates on the existing execution engine

Date: 2026-09-09. Backlog 24. Three templates implemented through the existing
approval/execution engine; final review and acceptance evidence are recorded below.
First targets are JARVIS/Second Brain operations. Production activation is separate.

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

The prerequisite alone did not complete backlog 24. The implementation below adds
the catalog, workflow binding and generic-path enforcement on that shared boundary.

Prerequisite verification on 2026-09-09: backend build, 34 integration tests in
four files (22.12s), lint and all three TypeScript configurations exited 0
(process handle81293). The tests cover dashboard HTTP approval/execution/durable
completion with fixture providers, unsupported-provider rejection before Git,
blob/aggregate limits, cancellation and stale baselines; offline validation also
runs the built CLI in a separate process. This is local integration verification,
not real-model template acceptance or production activation. The extracted
registration assertion retains the parser's narrowed V2 return type.

## Implemented interface

`jarvis routing templates` returns versioned definitions and digests without opening
an authority DB. `jarvis routing compile-template INPUT.json` accepts exactly:

```json
{
  "template_id": "technical-review",
  "revision": 1,
  "objective": "Review the supplied module and state the limits of the evidence.",
  "files": [
    { "path": "answer.mjs", "access": "read" },
    { "path": "report.json", "access": "write" }
  ],
  "verification": []
}
```

The result contains `proposal_request` and `task_template`. Submit the proposal to
`POST /api/v1/proposals/preview`, then include both fields alongside the normal
IDs, budget and returned `expected_proposal_digest` in `POST /api/v1/tasks`.
The template is in `workflow.start.args.input` before its command digest and approval
are created. After start approval, use the existing execution prepare/stage endpoints
with the same file scope and compiled verification array, then approve execution.
Compilation itself grants no authority. There is no new template picker UI yet.

The compiled proposal/binding pair is editable before approval: the binding does
not contain an objective or proposal digest. Callers may change the objective and
add constraints/evidence while retaining mandatory template requirements. The
final proposal digest and TaskSpec are validated normally; the signed workflow
input covers that final TaskSpec and template binding together. Do not treat an
earlier compiler output as a ticket for a different approved task.

The existing strict plan parser validates paths, duplicate/conflicting files,
checks, argv sizes and counts. Code-fix requires at least one caller-supplied check.
Report templates prepend a fixed sandbox check and require at least one read-only
source plus exactly one writable output. All initial checks are bound to workflow
approval; later execution checks may only add requirements. Report source-path
JSON must fit the existing 4096-byte per-argument limit; oversize is rejected, not
truncated. Existing plan/provider/file/HTTP resource limits still apply.

Each report is JSON with exactly `schema_version: 1`, `template_id`, `references`
and its template's section names from the table above. Sections contain 1–32
nonempty strings of at most 8192 UTF-8 bytes each. `references` contains 1–32
objects with exactly `path` and `quote`; every path must be a declared read-only
source and its nonempty quote must occur literally in that source. These checks
verify structure and quotations, not the truth of reasoning in the report.
No automatic remediation, memory promotion or incident-resolution claim is enabled.

The generic workflow validator requires template constraints/evidence in TaskSpec.
The generic execution binding checks exact file scope and every mandatory command
at preparation, staging and authority rechecks. Removing metadata after approval
also breaks the existing approved-workflow-input equality check. Unknown revisions
or changed definition digests fail closed. Preserve compiled historical versions;
changes to a version's checker or semantics require a new revision.

## Implementation verification

- First integration gate: 50 passed / 1 reviewability failure on long pre-existing
  lines in newly touched modules. Type placement and line formatting corrected;
  next gate: 51 passed, backend build/lint/three typechecks exit 0 (handle33431).
- Actual installed Claude plus independent Node verifier: one invocation each,
  verified result commit `84f89ba03b6d31d35581ae4722efddc134006fb0`, 37410ms,
  preparation writes 0, original HEAD/status/source preserved, replay causes no
  additional provider/verifier call or ref change. Isolated fixture operator key,
  DB and source repository; not production or a human browser approval acceptance.
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/template-real-AdGMLL/receipt.json`.
- The first live attempt was rejected before provider invocation because the local
  built verifier entry was mode 664. Restricting that generated local file to 644
  satisfied the existing permission check. Release file modes remain a deployment
  prerequisite; no permission check was bypassed.
- Subsequent parent inspection reproduced an option-shaped output-path bypass:
  `--help` made the old report command exit 0 and print 24861 bytes without checking
  invalid report JSON. Added the Node `--` separator and a regression test. Catalog
  snapshots are now detached from the internal definition arrays. The final source
  gate passed 53 tests in 5 files (29.33s), build/lint/three typechecks exit 0,
  handle58546. Additional test-only assertions exercise immutable workflow metadata
  and exact missing-requirements error classification.
- Final built source live acceptance after those two corrections: actual Claude 1,
  independent verifier 1, 24046ms, result commit
  `bcb977e774932cdfd189f8f4780bac284589144a`; same preparation/replay/source invariants
  as above. Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/template-real-ENDMT0/receipt.json`.
  Built artifact digest `sha256:915a1bf5a7dc2475902f79dd12cd359cdc8647b5ee022d1fee7e4fc26ddd0f93`.
- Workflow metadata mutation is rejected by the existing immutable-identity DB
  trigger before the execution binding check. The extra tests initially expected
  a later error and also changed a target run ID unintentionally; those fixtures
  were corrected without relaxing production validation.
- Exact-error testing also exposed that generic workflow staging previously deferred
  TaskSpec checks until execution. Template-bearing workflow starts now run that
  validation before staging. Final gate: 55 tests/5 files passed (29.88s), backend
  build/lint/three typechecks exit 0, handle44584. Final live acceptance including
  the pre-stage check: 36614ms, one actual Claude call and one independent verifier,
  commit `b0ca897e9b8a5c4669c17fd960a5df91d6e18aff`, same replay/source invariants.
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/template-real-WRnjoz/receipt.json`.
- Built HTTP server: proposal preview 200, template creation 202/pending, unknown
  revision 400/TASK_TEMPLATE_INVALID with 0 DB changes. Canonical persisted binding
  equals compiled binding. HTTP capability observations were fixture values; no
  provider invocation in this check. Receipt:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/template-http-sl0xRd/receipt.json`.

Remaining operational work: template selection/result labels in the dashboard,
real operational inputs and approvals, and evaluation of report reasoning. Existing
memory-source privacy HOLD and production activation boundaries remain in force.
