# Personal Operating System Contracts

Status: canonical todo-9 identifiers and future state contracts. Except for seams cited under “Source grounding,” these contracts are not implemented yet.

## Canonical envelope

Canonical JSON is UTF-8 with NFC strings, sorted object keys, no duplicate/extra keys, and no floats for time. Digests are lowercase `sha256:<64-hex>`. Times are UTC RFC3339 milliseconds. Every v1 envelope has:

| Field | Contract |
| --- | --- |
| `schema_version` | integer `1`; unknown versions fail before payload use with `PERSONAL_CONTRACT_VERSION_UNSUPPORTED` |
| `id` | branded family ID below |
| `created_at`, `observed_at`, `valid_at` | creation, acquisition, source-valid timestamps; none omitted |
| `source` | `{source_id, source_kind, host_id, source_version, evidence_ref}` with allowlisted source and explicit host |
| `authority` | `{authority_kind, principal_id, request_id, receipt_id}`; advisory families use `authority_kind:"none"` and null IDs |
| `freshness` | `{state:"fresh"|"stale"|"no_data"|"unavailable"|"offline", checked_at, fresh_until}` |
| `expires_at` | hard use boundary; only permanent tombstones may use null under explicit retention policy |
| `idempotency_key` | `idem:pos:v1:<scope>:<64-hex>`, derived from canonical semantic input, not attempt time |
| `correlation_id`, `causation_id` | operating-loop lineage and immediate cause; roots use null causation |
| `payload` | bounded family data; all text is untrusted data, never instructions/policy |
| `policy_decision` | `{decision:"allow"|"deny"|"abstain"|"not_applicable", policy_version, reason_codes[]}` from deterministic policy |
| `evidence` | bounded `{evidence_id,digest,kind,source_id,observed_at}[]`; prose cannot replace required evidence |
| `receipt` | family receipt or null; non-control receipts never grant effect authority |

Parsers reject unknown versions, fields, enums, authority kinds, prefixes, source IDs, timestamps, policy reasons, oversized/prototype-bearing/non-canonical input before persistence or model use. Retrieved/model text stays in `payload` and cannot populate authority, policy, IDs, source metadata, or receipts.

## Envelope and branded identifier families

`<uuid>` is lowercase RFC 9562 UUIDv7; `<hex>` is 64 lowercase SHA-256 hex. Correlation is `corr:pos:v1:<uuid>`, evidence is `evi:pos:v1:<uuid>`, source is `src:pos:v1:<provider>:<instance>`, and idempotency is the format above. Host IDs are exactly `host:pos:linux-control-plane`, `host:pos:linux-second-brain`, `host:pos:mac-client`, and `host:pos:phone-client`; a client cannot claim a Linux host ID.

| Family / type | ID | Required family payload / receipt | Todo 9 parser |
| --- | --- | --- | --- |
| Observation / `ObservationEnvelopeV1` | `obs:pos:v1:<source-id>:<uuid>` | kind, subject, bounded value, trust, sensitivity, cursor/checkpoint, content digest / null | `parseObservationEnvelopeV1` |
| Recommendation / `RecommendationV1` | `rec:pos:v1:<uuid>` | context ID/digest, ranked actions, citations, conflicts, omissions, confidence basis, `eligible|abstained|expired|rejected` / null | `parseRecommendationV1` |
| Context / `ContextSnapshotV1` | `ctx:pos:v1:<uuid>` | purpose/query, included/excluded observation/memory refs, pending authority refs, conflicts, omissions, budgets, `sufficient|insufficient` / null | `parseContextSnapshotV1` |
| Memory candidate / `MemoryCandidateV1` | `memcand:pos:v1:<uuid>` | `verified_fact|user_instruction|inference|correction|forget`, content/target digest, bounded content, sensitivity, confidence, confirmation and verification refs / confirmation receipt or null | `parseMemoryCandidateV1` |
| Memory outbox / `MemoryOutboxV1` | `memout:pos:v1:<uuid>` | candidate digest, `remember|correct|forget`, provider version, attempt/fence, expected artifact selector/digest, delivery state / required approval or confirmation | `parseMemoryOutboxV1` |
| Memory delivery / `MemoryDeliveryReceiptV1` | `memdel:pos:v1:<uuid>` | outbox ID, invocation digest, `accepted|uncertain|rejected`, observed SID/digest and reconciliation time / delivery evidence only | `parseMemoryDeliveryReceiptV1` |
| Notification / `NotificationIntentV1` | `ntf:pos:v1:<uuid>` | redacted preview, urgency, quiet-hours decision, channel, deep link, dedup, delivery state / delivery receipt only | `parseNotificationIntentV1` |
| Workflow run / `WorkflowRunV1` | `wfr:pos:v1:<uuid>` | recommendation/context/request, loop/state/node, lease/fence, verification requirements / exact control receipt before effect | `parseWorkflowRunV1` |
| Workflow checkpoint / `WorkflowCheckpointV1` | `wfc:pos:v1:<run-uuid>:<sequence>` | run/node, positive monotonic sequence, state/previous digest, lease/fence/expiry / null | `parseWorkflowCheckpointV1` |
| Remote principal / `RemotePrincipalV1` | `rpr:pos:v1:<uuid>` | subject, client kinds, public credential metadata, `active|revoked`; no private key/biometric / administrative receipt | `parseRemotePrincipalV1` |
| Remote challenge / `RemoteChallengeV1` | `rch:pos:v1:<uuid>` | principal/session, command/target/args digests, nonce, origin/RP, `issued|consumed|expired|rejected` / null | `parseRemoteChallengeV1` |
| Remote approval / `RemoteApprovalReceiptV1` | `rap:pos:v1:<uuid>` | challenge/principal/session/credential, assertion/command digest, decision, single use / translated into existing `CommandApprovalReceipt`, never parallel authority | `parseRemoteApprovalReceiptV1` |
| Deletion / `DeletionRequestV1` | `del:pos:v1:<uuid>` | exact selectors/digests, scope/reason/stores, verification plan / exact approval | `parseDeletionRequestV1` |
| Tombstone / `DeletionTombstoneV1` | `tmb:pos:v1:<hex>` | request digest, non-content subject digest/selectors, effective time, generations/stores, evidence / deletion receipt | `parseDeletionTombstoneV1` |
| Audit / `AuditEventV1` | `aud:pos:v1:<uuid>` | event, actor, subject, outcome, prior/event digest / actual receipt if any | `parseAuditEventV1` |
| Evidence / `EvidenceReceiptV1` | `evr:pos:v1:<uuid>` | kind, subject, verifier, artifact digest/ref, result, validity / proves only stated claim | `parseEvidenceReceiptV1` |

## State-machine transition contract

These exact textual machines are complete. Unlisted transitions fail closed as `*_TRANSITION_INVALID`; states with no listed outgoing edge are terminal. A failure disposition that names a destination state is an explicit alternate transition under that row's authority, idempotency, and freshness rules. For every row, same idempotency key plus same canonical payload returns the recorded result; same key plus changed payload is `*_REPLAY_CONFLICT`.

### Observation

States: `received`, `validated`, `fresh`, `stale`, `no_data`, `unavailable`, `offline`, `expired`, `rejected`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `received` | registered adapter identity; no effect authority | source+subject+version+cursor/content digest | reject future/invalid observation and already-expired envelope | malformed/unknown source/version -> `rejected`; not truth |
| `received` -> `validated` | deterministic parser/policy | observation ID+canonical digest | verify checkpoint and clock skew | schema/identity/scope/replay conflict -> `rejected` |
| `validated` -> `fresh` | deterministic freshness policy | observation ID+policy version | `checked_at <= fresh_until < expires_at` | required evidence absent -> `unavailable` |
| `validated` -> `no_data|unavailable|offline` | adapter health + deterministic parser | source+checkpoint/check attempt+status | successful current check with bounded expiry | preserve exact degradation; abstain when required, never fabricate empty result |
| `fresh` -> `stale` | deterministic clock | observation ID+freshness-policy version | clock passes `fresh_until` | exclude from current truth or abstain |
| any nonterminal current state -> `expired` | deterministic clock/retention | observation ID+expiry-policy version | clock reaches `expires_at` | exclude; retain bounded audit only |

### Recommendation

States: `drafted`, `parsed`, `eligible`, `abstained`, `presented`, `selected`, `rejected`, `expired`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `drafted` | recommender is advisory only | context digest+recommender version+purpose | context unexpired | unavailable model -> deterministic abstention, never authority |
| `drafted` -> `parsed` | deterministic parser | recommendation ID+parsed digest | recheck context/citations | malformed/extra authority field -> `rejected` |
| `parsed` -> `eligible|abstained` | deterministic policy | context digest+policy version+action digest | all required evidence fresh; expiry no later than context | conflict/stale/unavailable/no_data/insufficient -> `abstained`, no request |
| `eligible` -> `presented` | Linux projection, no effect authority | recommendation ID+client projection generation | still eligible/unexpired | projection failure leaves record; no auto-selection |
| `presented` -> `selected` | authenticated human intent, still not effect authority | recommendation ID+principal+selection digest | recheck recommendation/context | stale/mismatch -> expired/rejected; may only stage control request |
| any active state -> `expired` | deterministic clock | recommendation ID+expiry policy | earliest context/citation/recommendation deadline reached | no selection/dispatch |
| `eligible|presented` -> `rejected` | authenticated human or deterministic policy | recommendation ID+rejection digest | current record required | audit only; no dispatch |

### Workflow, run, checkpoint

States: `planned`, `waiting_approval`, `approved`, `claimed`, `running`, `verifying`, `completed`, `failed`, `blocked`, `uncertain`, `cancelled`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `planned` | planner advisory only | selected recommendation+workflow definition version | current recommendation/context | invalid graph/input -> `failed`; no request |
| `planned` -> `waiting_approval` | coordinator stages via `ControlPlane` | run ID+exact command digest | request bounded by recommendation/context expiry | stage failure -> `blocked` |
| `waiting_approval` -> `approved` | `ControlPlane` + exact human receipt | request+receipt | principal/digest/command/receipt/request current | reject -> cancelled; mismatch/expiry/replay fails closed |
| `approved` -> `claimed` | `ControlPlane` grants executor fence | request+receipt redemption | approval/request current; lease ends no later | duplicate claimant/stale fence -> `blocked`, no effect |
| `claimed` -> `running` | approved executor with current fence | run+node+fence | recheck lease/approval/request before effect | pre-effect loss -> blocked; unknown in-flight effect -> uncertain |
| `running` -> `verifying` | approved executor records effect | run+effect digest+fence | settle while current or reconcile | execution error -> failed; unknown outcome -> uncertain |
| `verifying` -> `completed` | independent deterministic evidence then `ControlPlane.settle` | run+evidence digest | evidence current for artifact/version | missing/failed evidence -> failed/blocked; prose never completes |
| pre-effect active -> `cancelled` | authenticated `ControlPlane` cancellation | request+revocation digest | valid revocation/current state | replay conflict fails closed |
| in-flight active -> `uncertain` | `ControlPlane` on loss/cancel/unknown effect | request+fence+loss/effect digest | authority/lease expired or outcome unknown | no auto-replay; reconcile |
| `running|verifying` -> `failed` | executor/verifier with evidence | run+failure evidence | current fence or reconciliation authority | preserve checkpoint; new safe key required for retry |

Every transition emits `WorkflowCheckpointV1` with monotonic sequence, previous digest, fence, and lease expiry; stale/skipped sequence fails closed.

### Memory candidate and outbox

States: `proposed`, `classified`, `awaiting_confirmation`, `approved`, `queued`, `delivering`, `accepted_unsettled`, `settled`, `rejected`, `uncertain`, `expired`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `proposed` | verified outcome/user-request producer, advisory | subject+content/target digest+cause | evidence/candidate validity explicit | observation/model cannot skip classification |
| `proposed` -> `classified` | deterministic memory policy | candidate+policy version | verification evidence current, valid-time explicit | unsupported/sensitive/poisoned -> rejected |
| `classified` -> `awaiting_confirmation|approved` | deterministic policy; only low-risk rule may approve | candidate+confirmation-policy version | candidate/evidence current | required confirmation cannot be skipped |
| `awaiting_confirmation` -> `approved` | exact human confirmation/approval | candidate+content digest+receipt | receipt/evidence/candidate current and principal exact | mismatch/expiry/wrong principal -> rejected/pending |
| `approved` -> `queued` | Linux outbox coordinator | candidate+operation+payload digest | approval current | uniqueness conflict -> replay conflict; no duplicate send |
| `queued` -> `delivering` | supervised Linux MCP writer with fence | outbox+attempt fence | provider compatible; lease current | pre-send failure -> safe retry with same semantic key |
| `delivering` -> `accepted_unsettled` | typed provider response; not settlement | outbox+invocation digest | inside write timeout | crash/interruption -> uncertain; no blind replay |
| `accepted_unsettled` -> `settled` | observe expected cited Second Brain artifact | outbox+expected artifact digest/SID | current generation, observation after acceptance | timeout/mismatch -> uncertain; inbox path insufficient |
| delivery active -> `uncertain` | reconciliation policy | outbox+attempt/invocation digest | timeout/unknown outcome | inspect artifact before retry |
| candidate active -> `expired` | deterministic clock | candidate+expiry policy | candidate/confirmation deadline | no queue/delivery |

### Notification

States: `created`, `deferred`, `ready`, `delivering`, `delivered`, `suppressed`, `failed`, `expired`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `created` | Linux informational policy | event class+subject+redacted digest+window | source event current; expiry required | command/credential/prohibited field -> suppressed |
| `created` -> `deferred|ready` | deterministic quiet-hours policy | intent+policy/window | wake before expiry; underlying decision current | defer past expiry -> expired |
| `deferred` -> `ready` | deterministic clock/policy | intent+delivery window | decision remains current | stale -> expired; duplicate -> suppressed |
| `ready` -> `delivering` | coordinator/client adapter, no effect authority | intent+channel+fence | intent and delivery lease current | unavailable client -> failed/bounded retry |
| `delivering` -> `delivered` | adapter delivery receipt | intent+channel receipt digest | receipt before expiry | uncertain evidence -> failed; never authority |
| active pre-delivery -> `suppressed|expired` | deterministic policy/clock | intent+reason/expiry policy | preference/policy or clock deadline | no delivery; redacted audit only |

### Remote approval

Principal states `active|revoked`; challenge `issued|consumed|expired|rejected`; approval `verified|translated|rejected`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> challenge `issued` | Linux gateway after active authenticated principal/session + pending command | principal+session+command digest+nonce | short expiry no later than command | wrong/revoked principal or stale command -> rejected |
| `issued` -> `consumed` + approval `verified` | Linux WebAuthn verifier | challenge+assertion digest | verify RP/origin, principal, credential, session, nonce, exact command/target/args, counter, expiry, unused | mismatch/wrong principal/expiry/replay/version -> rejected/expired, no receipt |
| `verified` -> `translated` | Linux adapter to existing `CommandApprovalReceipt` and `ControlPlane.decide` | challenge+command digest+decision | one consumed challenge; command/result receipt current | control rejection -> rejected; no parallel authority |
| `issued` -> `expired` | deterministic clock | challenge+expiry policy | deadline reached | assertion permanently refused |
| principal `active` -> `revoked` | Linux exact administrative authority | principal+revocation digest | immediate effect | all open challenges rejected |

Tailnet identity, browser session, biometric gesture, and client claim are admission evidence only, never approval.

### Personal-data transfer and restore

States: `requested`, `approved`, `staged`, `verified`, `tombstones_applied`, `rebuilt`, `activated`, `rejected`, `failed`, `expired`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> transfer `requested` | owner names `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL` | source commit+archive+manifest digest+staging ID | clean/frozen source, encrypted one-time window, expiry | missing proof/channel/manifest -> rejected, no copy |
| transfer `requested` -> `approved` | exact transfer-only owner receipt | request+command digest+receipt | source/window/receipt current | restore receipt cannot substitute; mismatch/expiry rejected |
| transfer `approved` -> `staged` | approved transfer executor | receipt+archive digest+new generation | inside window | partial/digest mismatch failed; stable vault unchanged |
| absent -> restore `requested` | owner names `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL` | backup+manifest digest+new generation | readable backup/manifest, expiring request | transfer receipt cannot substitute; no in-place restore |
| restore `requested` -> `approved` | exact restore-only owner receipt | request+command digest+receipt | request/receipt current | mismatch/expiry rejected |
| restore `approved` -> `staged` | approved restore executor | receipt+backup digest+new generation | new isolated immutable generation | partial/digest mismatch failed; stable unchanged |
| `staged` -> `verified` | manifest/integrity verifier | generation+manifest digest | complete isolated staging | failure blocks activation |
| `verified` -> `tombstones_applied` | deletion reconciler | generation+tombstone-set digest | latest tombstones loaded | any missing application fails; activation blocked |
| `tombstones_applied` -> `rebuilt` | Second Brain pipeline | generation+tombstones+pipeline version | indexes/briefs match generation | build failure/forgotten sentinel -> failed |
| `rebuilt` -> `activated` | approved Linux atomic switch executor | generation+verification digest | approval applicable; all checks current | switch failure leaves prior active |
| any pre-activation -> `expired` | deterministic clock | request+expiry policy | approval/window deadline | stop; never activate staging |

### Deletion and tombstone

States: `requested`, `approved`, `queued`, `applying`, `tombstoned`, `purging`, `verifying`, `settled`, `failed`, `uncertain`.

| Transition | Authority | Idempotency key | Freshness / expiry | Failure disposition |
| --- | --- | --- | --- | --- |
| absent -> `requested` | authenticated exact user selector, never model inference | subject digest+scope+policy | resolve current catalog without content exposure | ambiguous selector -> failed; no broad delete |
| `requested` -> `approved` | exact human receipt through `ControlPlane` | request+command digest+receipt | request/receipt current/exact scope | mismatch/principal/expiry/replay -> failed; no delete |
| `approved` -> `queued` | Linux coordinator | request+tombstone digest | approval current | same returns existing; conflict closed |
| `queued` -> `applying` | approved executor with fence | deletion+fence | lease/approval current | authority loss uncertain; no broad retry |
| `applying` -> `tombstoned` | JARVIS + Second Brain tombstone writers | deletion+non-content subject digest | immutable effective time | one-side failure uncertain; import/restore blocked |
| `tombstoned` -> `purging` | Second Brain deletion pipeline | tombstone+generation/store-set digest | dominates all generations/staged imports | partial purge failed/retry same key; tombstone persists |
| `purging` -> `verifying` | deterministic index/export/cache verifier | tombstone+resulting generation/index digests | covers active retrieval/pages/indexes/briefs/exports/caches | residual/sentinel -> failed, no settlement |
| `verifying` -> `settled` | independent evidence then `ControlPlane.settle` | tombstone+evidence digest | current active generation/stores covered | absent evidence failed; tombstone still blocks content |
| in-flight -> `uncertain` | coordinator on unknown outcome | deletion+fence/attempt digest | timeout/authority loss | tombstone dominates; reconcile before restore/import |

## Cross-contract rules

- Observation, context, recommendation, memory read evidence, notification, progress, timeline, and model output use `authority_kind:"none"`; their receipts cannot enter `ControlPlane.decide`.
- Context expiry is no later than its earliest required evidence; recommendation expiry is no later than context. A later control request is independently revalidated.
- `no_data` is a successful current provider check with no production data. It is neither fresh personal evidence nor an error. `unavailable`, `offline`, and `stale` remain distinct.
- Observation-derived candidates start at `proposed`; no direct path reaches queued/delivering/durable memory.
- Tombstones are checked before search, context, transfer, restore activation, indexes, briefs, exports, and caches; precedence never expires.
- Transfer and restore approval names, IDs, receipts, manifests, and idempotency namespaces never overlap.
- Every effect rechecks deterministic policy and exact authority outside the model; unknown policy versions abstain/deny.

## Source grounding

Current [`ControlPlane`](../../src/control-plane.ts) is the shipped authority path with existing request/receipt, expiry/replay, lease/fence, revocation, and uncertain semantics. Current [`TaskTimeline`](../../src/task-timeline.ts) is a mutation-guarded read projection; it does not implement `ContextSnapshotV1` or authorize effects. Existing contracts remain [Architecture Contracts](../planning/03-ARCHITECTURE-CONTRACTS.md), [Task Timeline](../TASK_TIMELINE_KO.md), and [Master Charter](../../ORCA_MASTER_CHARTER.md).

At Second Brain HEAD `011abade5b29de66af4722dfd9c21398064eeb1e`, `sb/contracts.py` defines `SourceRef`, `Blob`, `Unit`, `SourceCite`, `PageSpec`, `ConflictVerdict`, `BriefingInputs`; `sb/mcp.py` exposes `sb_search`, `sb_read_page`, `sb_recent_changes`, `sb_open_conflicts`, `sb_remember` over stdio. It does not expose these JARVIS envelopes, remote authority, transfer/restore orchestration, deletion reconciliation, or settlement receipts. Todo 9 owns parsers/types; later todos own persistence and behavior as mapped in [architecture.md](architecture.md).
