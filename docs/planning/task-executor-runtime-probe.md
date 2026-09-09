# Explicit executor runtime probe

Status: implemented and independently reviewed; not operationally enabled.
Inspection baseline23cc5d2. Actual compiled routing executors returned exit0,
1registered executor (claude-code),3missing configuration fields in the current
shell, readiness/authentication not_probed and execution_available false.
Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/task-executor-current-inventory.json.

The existing probeTaskExecutor invokes only the local authentication probe.
createClaudeRuntime.checkReady already resolves the trusted provider executable,
checks the independent verifier key/process, validates the clock and runs an empty
sandbox Node command. Reuse that implementation for an explicit runtime diagnostic;
keep passive inspection and auth-only probe behavior unchanged.

The runtime diagnostic must report unregistered, missing configuration, unavailable,
or locally ready with bounded reason codes. It must not produce a task candidate,
redeem an approval, write workflow state, or mark execution_available true. Local
readiness is not remote authentication success or task authority. Do not expose raw
errors, executable output, private key material or configured secret paths.

Acceptance: missing/unsupported settings cause no process launch; readiness failure
is represented independently of authentication; a real isolated verifier/sandbox
probe returns a structured local observation without model calls or DB writes.
Bind any configurable clock to validation, and make readiness rechecked at actual
execution so this observation never substitutes for execution preflight.


Implemented interface: `jarvis routing probe-runtime claude-code` and exported
probeTaskExecutorRuntime(id, env). Result readiness contains state, local scope,
remote_verification not_performed and bounded reason code where relevant.
preflight_passed means only existing runtime.checkReady succeeded: provider file
resolution, verifier entry/key metadata, boot clock and an empty sandbox Node run.
It does not establish verifier key cryptographic usability or remote login validity.
execution_available remains false and authentication remains not_probed.

Verification: registry/probe2files8tests passed; reviewability/probe2files5tests
passed; lint/typecheck/build exit0. Actual compiled success used the installed
provider path, an ephemeral generated Ed25519 key and real bubblewrap execution;
no provider process, login call or model invocation. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/task-runtime-probe-live.json.
Temporary key files were removed. Independent runtime_probe_review: ship, findings 0.
Review covered CLI dispatch before database construction, environment snapshot,
bounded diagnostics, unchanged authority/authentication semantics and checkReady
process scope. No model transport or approval redemption occurs in this probe.


Compiled CLI acceptance: two separate child processes ran
`routing probe-runtime claude-code`. With the three configuration variables removed,
readiness was not_probed. With the installed executable and a temporary generated
verifier key, readiness was preflight_passed and execution_available remained false.
Both exited0. The parent shell environment was unchanged and temporary key material
was removed. Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/task-runtime-probe-cli.json.
This command dispatches before database construction; no --db argument was used.


Diagnostic regression follow-up: seven probe tests now assert all four allowlisted
reason codes and the generic fallback for ordinary errors and unknown JarvisError
codes. Failure paths also assert zero candidate generation. Probe/reviewability
9 tests passed; after the tuple typing correction, probe 7 tests passed again.
Compiled CLI with installed Claude and a nonexistent verifier key returned exit 0,
readiness unavailable/TASK_VERIFIER_UNAVAILABLE, execution_available false and
zero configured path/key-ID leaks. This is failure-path acceptance, not task execution.
