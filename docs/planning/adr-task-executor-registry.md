# Task executor registry shared by inspection and execution

Date: 2026-09-09. Backlog 21, following work routing preview 20.

Production task runtime creation and readiness previously assumed Claude directly.
Move the existing implementation into a private, compiled executor registration.
Both the approved execution path and readiness resolve the exact plan provider
through this registration; there is no fallback to a different provider.

The initial registered executor is `claude-code`, mapped to plan provider `claude`.
Its supported plan is version 2, verified_git_commit, with declared repository
file scope, existing single-use approval and independent verification. Runtime
creation retains the existing CLI, verifier and sandbox checks. The registry does
not relax request, signature, lease, revocation, deadline or completion checks.

`jarvis routing executors` lists compiled registrations; `jarvis routing executor
ID` inspects one ID used by the routing policy. These commands run before opening
AuthorityDb and do not call agents or inspect authentication. Configuration status
means only that all required host environment variables are nonempty; it does not
certify paths, credentials, protocol compatibility or authority. Only variable
names and missing names are emitted, never values or private paths. Every result
has execution_available=false and readiness/authentication=not_probed: an approved
plan and the normal runtime preflight are still required before dispatch.

Unregistered IDs remain unregistered, including cursor, mail-intelligence,
sangfor-os, sangfor-engineer-mcp and cowork from the routing preview. Codex task
plans remain unsupported. No external JSON can install factories or choose command
paths. Adding an executor requires a reviewed implementation and contract tests.

Remaining work includes external executor input/result contracts, authenticated
readiness, approval-bound routing in task admission, and actual external workflow
acceptance. Registry presence alone does not complete backlog 21.

## Verification evidence

- Backend build, 30 tests across registry/runtime/approved execution/routing CLI/
  module reviewability, lint and all three TypeScript configurations: exit 0.
  The test run took 17.44 seconds. Approval cancellation, expiry, revocation,
  verifier failure and uncertain publication are covered by existing regressions.
- Separate compiled CLI processes 1247649/1247663/1247713/1247746 exercised list,
  registered ID, unregistered ID and malformed ID. Exit codes: 0/0/0/2;
  database files created: 0. This is inspection acceptance, not a model execution.
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-registry-l201mi_1/receipt.json`.
- Configured-but-unusable provider/key paths in the compiled CLI regression remain
  configuration=present, readiness/authentication=not_probed; provider marker and
  database files are absent, and supplied private values are absent from output.
- The separately running full verification uses frozen commit e70d113 and excludes
  this registry unit. Do not cite it as full verification of these changes.
- Read-only reviewer `/root/executor_registry_review`: ship, no required fixes.
  Requested gpt-5.6-terra/high; actual model and effort unavailable in metadata.
  Existing trusted host/test runtime injection remains supported and can bypass
  the factory, but still passes normal runtime and execution authority checks.
  Request/policy JSON cannot supply that injection.

## Shared resource limits

The registry now exposes `limits.plan`, `limits.provider` and `limits.files` from
the same immutable compiled module used by plan parsing, provider preparation and
transport, execution clock/verifier admission, workspace capture, candidate verification/artifact decoding, and Git
publication reads. This removes independently maintained copies of those limits.

Plan timeout remains 1,000–600,000ms and output budget 1,024–1,048,576 bytes, with
at most 128 declared files and 8 verification checks. Provider remaining budgets
can be as small as 1ms/1 byte; these are not new plan-admission minima. Prompt limit
is 524,288 bytes, individual file limit 4,194,304 bytes and aggregate file limit
16,777,216 bytes. These are independent upper bounds: prompt/envelope overhead and
the smaller plan budget can reject inputs or outputs below a file-size maximum.

No limits are writable through a policy or request. The artifact envelope's 24MiB
and measurement's 256KiB caps remain separate encoding limits. This change does
not introduce a configurable external adapter schema or authenticated readiness.

Initial validation: backend build, 131 tests in 11 files (32.27 seconds), lint and all
three TypeScript configurations completed with exit 0. Tests include plan-bound
admission, smaller remaining provider budgets, compiled registry inspection,
workspace checks, candidate artifacts and SIGKILL recovery around Git publication.
Separate compiled CLI inspection PID1294188/exit0 returned the declared limits,
execution_available=false and created zero database files. Receipt:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-limits-K0TryU/receipt.json`.
This does not prove external model authentication or production deployment.

The initial read-only review returned fix-first for two remaining timeout literals
in execution-clock and verifier-process admission. Both now consume the shared
limits. The expanded rerun passed 152 tests in 14 files (32.99 seconds), including
clock, verifier process and actual verifier SIGKILL recovery.
Final backend build, lint and all three TypeScript configurations also exited 0.
A separate compiled Linux-clock/verifier-admission process PID1317066/exit0 checked eight boundary
cases without spawning a verifier or model:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-clock-limits-P3trxH/receipt.json`.

Fresh final review `/root/execution_limits_final_review`: ship, findings 0.
Requested luna/high; actual model and effort are unavailable in tool metadata.

## Input validation and result identity

`jarvis routing validate-plan claude-code PLAN.json` validates a plain execution
plan using the same `parseRegisteredTaskExecutionPlan` function as runtime
preflight. It requires the current compiled executor's version, mode and provider
as well as the existing closed plan shape, paths, digests and resource bounds.
Only a plan digest and validation status are emitted; plan contents and private
paths are not echoed. Input files are bounded to 4MiB and must be regular,
non-symlink, valid UTF-8 JSON files, using the existing bounded routing reader.

Success means structural input validity only. No database is opened, no approval
is consumed, no source repository is inspected and no provider is called. Output
explicitly reports execution_available=false, authority/repository=not_checked
and readiness/authentication=not_probed. Offline inspection is not an execution
ticket: normal workflow binding, approval, preflight and file checks still apply.

Registry contract names reference source contracts, not standalone JSON Schemas:
input `TaskExecutionPlan` version 2; successful `result` payload `TaskCompletion`
version 1. The latter must come from persisted completion/publication/verifier
bindings; model candidate output is never completion. Existing completed-request
replay returns the verified historical result without another model invocation.
These names and versions document the current adapter and do not implement a
generic external adapter registration or an offline completion-proof verifier.

Validation: 70 tests in 7 files (18.61 seconds), backend build, lint and three
TypeScript checks exit 0. Tests cover shared plan rejection, approved execution
and replay, cancellation/revocation, bounded-file hazards and CLI non-disclosure.
Separate compiled CLI PIDs1348722/1348735/1348750/1348763 returned 0/2/2/2 for
valid/unsupported/unregistered/invalid inputs, with zero database files and no
private marker in output. Receipt:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-plan-1t2alrlb/receipt.json`.
The concurrent full verify is frozen at 8b98cd8 and excludes this unit.

Read-only review `/root/executor_plan_review`: ship, findings 0. Requested
luna/high; actual model and effort were not exposed by tool metadata.


## 2026-09-10 Codex adapter admission investigation

At JARVIS3adb8d8, task-execution-plan.ts accepts provider=codex in the signed shape,
but task-executor-registry.ts contains only the compiled Claude factory. Syntactic
acceptance does not mean that a Codex runtime is available. The shared candidate
boundary accepts declared file content plus the exact execution_plan_digest;
it preserves read-only snapshot inputs and independently verifies publication.

Local read-only CLI inspection returned codex-cli0.153.4 at
/home/jm/.nvm/versions/node/v24.19.0/bin/codex. `codex exec --help` exited0 and
advertised --output-schema, --json, --ephemeral, --ignore-user-config,
--ignore-rules, --sandbox and --cd. No task prompt, authentication operation,
model request or provider execution was performed. This local version/help result
is not authenticated execution evidence and does not describe other installations.

Admission remains held until an adapter satisfies the actual candidate-only contract:

1. Verify an installed version and its supported invocation/configuration against
   a pinned protocol; do not guess configuration keys from feature names.
2. Demonstrate that model tools, MCP, hooks and ambient project/user instructions
   cannot expand the declared snapshot or execute side effects. Read-only shell
   sandbox selection alone is not evidence that external tools are disabled.
3. Parse bounded JSONL while bounding combined stdout/stderr, enforce one remaining
   deadline and process-tree cancellation, and reject missing/duplicate/malformed
   terminal candidate results. Do not treat a CLI success event as TaskCompletion.
4. Preserve execution_plan_digest and declared file scope through the existing
   candidate parser, independent verifier, single-use approval and Git publication.
5. Exercise a real isolated approved change, timeout, cancellation, stale approval,
   hostile tool request, unexpected output and restart/replay before registering
   the compiled factory. No automatic fallback from Claude to Codex.

This is a concrete adapter acceptance checklist, not an implementation or claim
that the inspected CLI lacks all possible isolation mechanisms. The installed
binary alone is insufficient to enable the executor. Existing Claude development
and other backlog items remain in scope.


## 2026-09-10 Codex feature override readback

Official configuration reference fetched from
https://learn.chatgpt.com/docs/config-file/config-reference (redirect from
https://developers.openai.com/codex/config-reference/) documents features.shell_tool,
features.unified_exec and features.multi_agent as separate switches. It also describes
app enabled settings and plugin-specific MCP enabled settings. These are configuration
surfaces, not proof of an empty effective tool inventory.

Read-only installed CLI0.153.4 experiment:

```
codex features list --disable shell_tool --disable unified_exec --disable multi_agent
multi_agent   stable false
shell_tool    stable false
unified_exec  stable true
```

A separate `codex features list -c features.unified_exec=false` also reported
unified_exec=true. Both commands exited0. This was the current local effective
configuration; no model prompt ran. Do not infer either that exec tools are exposed
when shell_tool=false, or that tool execution is fully disabled, from this feature
listing alone. The override/readback discrepancy requires an actual tool-inventory
and side-effect isolation probe before compiled registration.

Raw non-secret feature-list receipts: shared QA codex-candidate-features.txt and
codex-unified-exec-override.txt. No user configuration or auth file was edited.
No unsupported feature key was invented, no bypass flag was used, and the current
Codex execution hold remains pending effective-tool evidence.


## 2026-09-10 effective tool inventory at the local wire boundary

A loopback rejecting mock Responses provider captured only tool names/counts from
Codex0.153.4 requests. It returned HTTP400 intentionally; child exit1 is expected,
not a successful model run. No model response or tool call was issued. Request
input and credential contents were not persisted or printed. GET models requests
had no JSON body and are marked parse_error in the diagnostic receipt.

The invocation used an empty temporary cwd, read-only sandbox, ephemeral session,
ignore-user-config, ignore-rules, disabled web_search, and disabled shell_tool,
unified_exec and multi_agent. First /v1/responses advertised23tools, including
app namespaces, MCP resource readers, user input, plugin install and view_image.
No shell or unified exec tool appeared in that observed request. This resolves
one ambiguity in the earlier feature listing: unified_exec=true did not alone
prove shell tool exposure for this invocation.

Adding --disable apps, apps._default.enabled=false and tools.view_image=false
reduced the observed tool list to2: request_user_input and view_image. Thus the
second invocation still does not establish a candidate-only tool-free boundary.
Do not register it based merely on the reduction in count or the declared sandbox.
The missing image-tool suppression requires version-specific implementation evidence
or a separately enforced process/filesystem boundary and hostile-call tests.

Official configuration source for custom local provider, apps and view-image
settings: https://learn.chatgpt.com/docs/config-file/config-reference.
No global user configuration or authentication file was modified. Diagnostic scripts
and receipts are QA codex-tool-inventory-probe.mjs / codex-tool-inventory.json and
codex-tool-inventory-no-apps-probe.mjs / codex-tool-inventory-no-apps.json under
/home/jm/.cache/jarvis-test-runtime-qa-20260908. This wire probe is not a production
adapter, remote authentication test, model-quality test or end-to-end task completion.
