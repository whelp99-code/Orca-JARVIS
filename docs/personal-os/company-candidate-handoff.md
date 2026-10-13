# Company candidate representative approval

Issue [79](https://github.com/whelp99-code/Orca-JARVIS/issues/79).
SB wire contract: PR67 at `20ca51361202331de8321e2c8c741610e673969b`,
`docs/core5/COMPANY-CANDIDATE-HANDOFF.md`. This implementation is opt-in.
No operating keys, enrollment, service, timer, deployment or actual candidates
were provisioned. Existing personal memory candidates and outbox are not used.

## Authority and caller separation

The SB data owner runs two bounded broker instances, one `handoff`, one
`processor`. Each pins an absolute `sb-company` executable, an absolute private
SB config and a Unix socket. Stdin cannot select an executable, config, database
or additional CLI action. The child environment contains only fixed PATH and
the broker account's HOME; inherited SB config, Python path and loader variables
are discarded. Requests/responses are bounded to 1 MiB and calls to 10 seconds,
with at most eight clients per broker. There is no automatic retry or drain.

The JARVIS importer has a handoff-scoped key. The processor has a different
principal and processor key, limited to accept/reject/mark_processed. Neither
may share representative decision key material, even with another key ID.
SB separately enforces ordinary/processor/owner key separation and enrollment.
The existing JARVIS owner signer stays behind the representative passkey
ceremony; the company executor never accepts a signer or creates owner proof.

Provisioning is an operator action after review. Keep each account's configs
and signing files owned by that account, regular, non-symlink and mode0600,
with private0700 directories. Suggested independent client paths are:

- `/var/lib/jarvis-svc/credentials/second-brain/company-handoff/client.json`
- `/var/lib/jarvis-svc/credentials/second-brain/company-processor/client.json`

The broker runs as the SB data owner. Do not grant the processor direct access
to `company.db`. Default transport uses a0700 parent and0600 socket and is for
same-account isolated use. For different OS accounts, the operator can prepare
a dedicated SB-owned0710 socket directory with a dedicated caller group, then
explicitly set `caller_group_id` in that broker config. The broker verifies the
directory group and creates a0660 socket for only that group. Keep SB database,
configs and key directories outside this traversable directory and private.
Use distinct caller groups for the two roles when their callers differ.
No accounts, groups, ACLs or operating permissions were changed by this task.

Broker config, with placeholders replaced by operator-owned paths:

```json
{
  "schema_version": 1,
  "role": "handoff",
  "socket": "/run/sb-company-handoff/company.sock",
  "sb_company_bin": "/absolute/immutable/sb/bin/sb-company",
  "sb_config_file": "/absolute/private/sb-handoff-config.json",
  "caller_group_id": 1234
}
```

Omit `caller_group_id` for private same-account transport. Use a separate
processor broker config with `role="processor"` and SB processor config.
SB config bytes must use SB's canonical JSON format; do not pretty-print or
re-serialize them with ordinary JSON defaults. Broker/client configs below use
the independent bounded company parser.
The executable must be an owned regular executable, not a symlink or writable
by other users. Its full directory chain must have current-account or root
ownership and must not be group/world-writable unless it is a trusted sticky
directory. The broker checks the chain at startup and before every dispatch.
It refuses an existing socket instead of unlinking it.

```bash
node dist/src/company-candidate-broker-main.mjs --config /absolute/broker.json
```

Client config has exactly `schema_version`, `role`, `context`, `socket`,
`signing_key_id`, `signing_key_file`. Context has exactly:
`provider_instance_id`, `workspace_id`, `owner`, `agent_id`, `session_id`,
`projects`, `policy_revision`, `deletion_sequence`, `deletion_set_root`,
`processor_principal_id`. It must equal the trusted SB enrollment/access fence.
The two client configs must agree on the enrolled identity/access fence and use
their respective key and socket. Agent/session values are role-specific and
must match that role's pinned SB config; they need not equal the importer caller.
No personal reader credential or personal memory environment is used.

## Bounded pull and representative decision

```bash
jarvis company-candidates import --company-config /absolute/handoff-client.json \
  --limit 100 --db /absolute/jarvis-authority.sqlite --json
```

One invocation imports one bounded page at offset0, never an unbounded drain.
Schedule it only after account/config/enrollment review; a suggested upper bound
is one invocation per minute, with no overlapping caller. It does not sign an
owner decision. Repeated export imports are no-ops by exact request ID/digest.
An already stored current handoff with the same digest and access fence remains
a no-op after expiry, preserving its decision and receipts. Freshness is checked
only for new request IDs; conflicting replays and new expired rows still fail.
The logical key, target, access fence, generation, lifetime and command digest
are recomputed and checked. One bad item rolls back the whole page.

An expired pending, unconsumed generation is cancelled and superseded in the
same transaction as importing the current generation. Its old proof cannot
approve the new request. A live or already decided/attempted generation conflict
fails closed for reconciliation rather than silently copying a decision.

Open the normal `/approvals` screen. The company item states that approval
authorizes this candidate's acceptance and later completion only after verified
downstream work. Its native disclosure shows company-only identity/access-fence
metadata, not source content. The existing passkey challenge binds the exact
request/digest/decision; its existing decision signer creates the original
`CommandApprovalReceipt`. Reject signs the exact same command with reject.

Company actions are excluded from the generic autonomous control queue/claim.
After representative approval the item waits for the separate processor. A
representative rejection is stored locally; the processor must forward it to SB.

## Processing and verified completion

```bash
jarvis company-candidates execute company-handoff:v1:HEX:GENERATION \
  --company-config /absolute/processor-client.json \
  --db /absolute/jarvis-authority.sqlite --json
```

This sends the original owner receipt and a freshly signed processor authority
to SB `process` accept/reject. Company request/authority domains match SB v1.
Acceptance alone leaves the local request approved and the company state
accepted. Without a completion verifier, `mark_processed` is never called.
Reject is terminal and never runs downstream completion.
An unforwarded signed rejection stays read-only in the representative inbox.
Open its company scope disclosure to copy the exact `request_id` into the
execution command; it disappears only after the SB rejection receipt is retained.

For completion, explicitly add:

```bash
--company-completion-config /absolute/company-completion-verifier.json
```

That private0600 config is a closed object with `schema_version:1`,
`executable` (absolute path) and `args` (fixed string array, at most16).
The executable must be a canonical regular non-symlink file, owned by the
service account or root, executable and not group/world-writable. Its directory
chain must have trusted ownership and prevent replacement by other accounts;
trusted sticky temporary directories may contain service-owned private fixtures.
The pinned program receives `{schema_version:1,command,acceptance}` on stdin,
with the exact command and retained acceptance metadata. It must perform or
independently verify the actual downstream work idempotently by request/digest,
then emit exactly:

```json
{
  "schema_version": 1,
  "state": "completed",
  "request_id": "company-handoff:v1:HEX:GENERATION",
  "command_digest": "sha256:HEX",
  "candidate_id": "opaque-sb-company-candidate",
  "content_digest": "sha256:HEX",
  "acceptance_receipt_digest": "sha256:HEX",
  "effect_digest": "sha256:HEX"
}
```

Do not configure a program that merely echoes this input. Exit success alone
is insufficient: all identities/digests must bind this exact accepted candidate.
The trusted verifier's evidence digest names its independently checked durable
effect. No downstream business operation is invented by the company connector.
The program is bounded to10 seconds/1 MiB and receives no signing key. Only
verified evidence is persisted before a fresh signed `mark_processed`.

SB receipt metadata and completion proof are retained in company-only tables
and control effects. Their digest identifies SB's internal receipt; the reduced
metadata is not a replacement for SB's full signed-input audit.

## Failure and replay

Local imports/receipt persistence are transactional. An uncertain external
result is not reported completed or rolled back remotely: retain the same
request and original owner receipt for an explicit retry. SB exact replay
returns its original receipt. The local lease serializes workers; receipt and
effect persistence commit together. A failure after SB acceptance preserves
that evidence, leaves completion unconfirmed and never fabricates success.

Current JARVIS decision-key trust and local revocations are checked before
each external phase. SB checks its own current pinned owner keys on replay
and completion. Propagate rotations/revocations to both trust roots; SB does
not query JARVIS's revocation registry. A local approved request that has not
been consumed by SB must still have a valid first-use receipt window.
Local pre-call redemption is not proof of SB consumption. Expiry is relaxed
only after the matching accept/reject receipt is durably retained locally.
If a first call or local receipt commit fails, an expired retry is refused
without dispatching an apparently fresh use.

## Focused verification

Build backend before the broker's real-process tests:

```bash
npm run build:backend
node scripts/run-tests.mjs backend \
  tests/unit/company-candidate-import.test.ts \
  tests/unit/company-candidate-execution.test.ts \
  tests/unit/company-candidate-transport.test.ts \
  tests/integration/owner-inbox-execute-all.test.ts --no-file-parallelism
```

The tests cover idempotency, expired generations, exact scope/digest, separate
key material, forged/reused approvals, processor-only denial, downstream refusal,
SB response substitution, page/receipt rollback, exact retry and worker exclusion.
Operating adoption, live19-candidate inbox population and production processing
are separate operator work, not claimed by PR readiness.
