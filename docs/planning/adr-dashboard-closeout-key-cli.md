# Dashboard closeout public key configuration

The dashboard entrypoint must accept the external trust anchor used by Today.
Add paired `--closeout-key-id` and `--closeout-public-key-spki` options. The public
key uses the existing canonical base64url Ed25519 SPKI representation. Validate
both CLI and programmatic startup inputs before opening AuthorityDb. An omitted
pair preserves the unavailable closeout display; a partial or invalid pair fails
startup with VALIDATION_ERROR. No key is learned from a stored artifact.

This configures verification only. It does not create a signer, rotate historical
keys, authorize production activation, or supply the actual evening producer.

To configure an approved dashboard launch, append both options to its existing
arguments: `--closeout-key-id <trusted-key-id> --closeout-public-key-spki <base64url-spki>`.
Obtain these values from the independently configured signer, never from the
artifact being verified. The key is public, not PEM or private signing material.
The current contract supports one key; historical multi-key rotation remains open.

Validation: backend build, lint and all three TypeScript checks exited 0.
The two focused integration files passed 15 tests in 14.77 seconds. The compiled
CLI subprocess accepted the pair and returned a signed synthetic closeout with
one verified completion over HTTP. Three invalid/partial configurations exited 2
with VALIDATION_ERROR and no database file; invalid programmatic input also failed
before opening the database. This is isolated process testing, not production use.
Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/dashboard-key-cli-*.log`.

Existing closeout crypto/bounds regression: 2 files, 16 tests passed (3.05s).
Fresh read-only review `/root/dashboard_key_cli_review`: ship, 0 blocking findings.
Requested gpt-5.6-luna/high; actual model/effort were not exposed by the tool.
