# Backend artifact permissions

2026-09-09; backlog15/19/21. Current compiler output inherits host umask002:
compiled task-verifier-main.js is664 and actual NodeTaskVerifierProcess.checkReady
fails TASK_VERIFIER_UNAVAILABLE before provider execution (exit2).

Build subprocess sets its umask to existing mask OR022 before creating staging and
spawning tools. Copy operations can retain source modes, so enumerate/validate
complete generated artifact files first, remove group/other write bits, then compute
the final mode-aware identity before existing atomic publication. Restrictive masks
are not widened; executable bits and file contents are retained. No source files,
installed dependencies, verifier checks or production releases are modified.

Staging is exclusively owned by the build process. This does not defend against a
malicious same-user process mutating staging concurrently. Full deployed dependency
and ancestor ownership validation remains a separate packaging/readiness concern.

## Validation

Build +55tests/5files17.32s +lint +3TypeScript checks exit0(handle48867).
Tests cover content preservation, executable bits, restrictive modes, idempotence,
symlink refusal before changes, mode-aware runtime identity and existing verifier
key/input rejection.

Actual child build with umask000 and fresh Node probe exit0(handle50995):
1138artifact files, group/other writable0, verifier entry644, checkReady succeeds
without manual artifact chmod. A private key changed to640 is still rejected,
restored600 is accepted. Generated Ed25519 test key and isolated migrated SQLite
DB only; build and DB identity both matched. Model0/production0.
The initial acceptance harness39982 passed build/mode/readiness checks but supplied
AuthorityDb instead of its SQLite handle to the runtime reader and failed an
unavailable-vs-matched assertion. Corrected harness passed; product was unchanged.
Keys and DB removed after each probe. Source/installed dependency modes unchanged.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/backend-permission-SghXnC/receipt.json
Script: /home/jm/.cache/jarvis-test-runtime-qa-20260908/backend-permission-live.mjs
