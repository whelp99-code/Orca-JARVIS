# Personal Operating System Privacy and Security Policy

Status: policy contract for future personal-operating-system consumers. The parser and evaluator in `src/personal-os-policy.ts` consume `config/personal-os-policy.json`; no connector, persistence layer, notification adapter, transfer, restore, export, deletion workflow, Mac client, or phone client is activated by this document or task.

## Boundary and threat model

Linux is the sole authority and runtime. JARVIS authority state remains in Linux `AuthorityDb`; durable personal memory remains in the separate Linux Second Brain provider. Mac and phone are redacted clients and cannot own policy, memory, approvals, receipts, or effects. The policy evaluator returns an eligibility decision only: it cannot grant effect authority, mint an approval, call `ControlPlane`, mutate Second Brain, or copy personal data.

Protected assets are personal memory, live observations, notification content, exports, deletion state, vault generations, authority identity, and exact consent receipts. Relevant threats are cross-principal access, stale input, over-retention, secret or raw-body capture, client leakage, prompt injection, poisoned memory, model-authored policy, approval substitution, and transfer/restore resurrection. Existing controls remain independent and stronger where applicable: dashboard output redaction bounds values and secret-named keys; secure filesystem operations pin owner/inode and refuse symlinks; control actions use a closed action registry and exact Linux-local targets.

The design follows data minimization, purpose limitation, accuracy/correction, erasure, storage limitation, and privacy by design principles reflected in GDPR Articles 5, 16, 17, and 25. Threat treatment is organized around NIST AI RMF govern/map/measure/manage and OWASP LLM/Agentic guidance for prompt injection, excessive agency, sensitive disclosure, and memory poisoning. These references guide review; the JSON values are the deterministic runtime contract.

## Machine policy map

The top-level JSON object is closed and versioned. Unknown versions, keys, actions, tiers, malformed UTC timestamps/times, wraparound or empty quiet windows, unbounded retention, missing behavior, unsafe notification allowlists, and contradictory host ownership fail with `PERSONAL_POLICY_INVALID`. Policy validity is bounded to 366 days and each data class retention is a positive integer no greater than `retention.max_days`.

Sensitivity tiers are `public`, `personal`, `sensitive`, and `restricted`. Allowed purposes are enumerated and bound one-to-one to the seven data classes. Purpose changes require a new parsed input and cannot be inferred from retrieved or model text.

| Data class | Purpose / Linux owner | Retention | Consent and lifecycle | Client behavior |
| --- | --- | ---: | --- | --- |
| `memory` | `personal_memory` / Second Brain | 3650 days | sensitive/restricted requires `PERSONAL_MEMORY_CONFIRMATION`; exact export/delete; transfer and restore gates apply | redacted |
| `observation` | `live_awareness` / control plane | 30 days | no confirmation to observe; exact delete; no transfer/restore | redacted |
| `notification` | `owner_notification` / control plane | 7 days | allowed export/delete; no transfer/restore | redacted allowlist only |
| `export` | `data_portability` / control plane | 1 day | `PERSONAL_DATA_EXPORT_APPROVAL` | metadata only |
| `delete` | `data_erasure` / control plane | 30 days | `PERSONAL_DATA_DELETE_APPROVAL`; future deletion workflow must preserve tombstone precedence | metadata only |
| `transfer` | `vault_migration` / Second Brain | 1 day | only `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL` | prohibited |
| `restore` | `disaster_recovery` / Second Brain | 30 days | only `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL` | prohibited |

Every class explicitly defines purpose, retention, confirmation, export, deletion, host ownership, `no_data`, transfer, restore, and client projection behavior. `no_data` always returns `abstain`; it is never fabricated personal evidence or permission to proceed.

## Capture, projection, and notification

`secret`, `raw_body`, `raw_screen`, `audio`, and `video` are prohibited field classes. They are denied before any client projection. Full mail/calendar bodies, continuous screens, audio, and video therefore have no default ingestion path. Future adapters must classify fields before calling the evaluator and must retain the existing filesystem and dashboard redaction controls.

Notification payloads are limited to `title`, `summary`, `alert_class`, and `deep_link`. From 22:00 through 23:59 UTC only `authority_expiry` and `security_incident` alert classes are eligible; other alerts abstain. Notifications are informational: no payload or deep link is an executable command, credential, receipt, or approval.

Mac and phone projections require a configured client ID and return `redact`, metadata-only redaction, or denial according to the data class. Clients may cache only bounded expiring projections and cannot copy canonical personal data or fall back to local authority.

## Consent, export, deletion, transfer, and restore

A `require_confirmation` decision names a stable exact gate ID. It is not an approval receipt and causes no effect. Future consumers must present the named gate through the existing Linux authority path, bind it to exact principal/input/digest/expiry, and re-evaluate before effect.

Export and deletion use separate gates. Mac-vault transfer and Linux production restore also use separate gates; neither may substitute for the other. Transfer requires a frozen source, manifest and archive digest, encrypted bounded window, isolated staging, and no copy without the exact transfer receipt. Restore requires a new Linux generation, tombstone reapplication, rebuild and forgotten-sentinel proof before an atomic switch. This task implements none of those effects.

Correction and erasure workflows must preserve provenance while minimizing audit content. Deletion tombstones dominate active, cached, exported, transferred, restored, indexed, and generated copies. Retention expiry removes eligible content through the future owner-specific workflow; policy does not authorize silent indefinite retention.

## Principal, freshness, and untrusted content

Inputs bind the owner principal, data class, action, purpose, sensitivity, Linux owner host, observation time, freshness deadline, hard expiry, retention boundary, and payload field classes. Wrong principal, wrong owner, mismatched action/class, stale or expired input, future/contradictory time, and retention overflow deny with stable reason codes. Unknown or malformed input returns `MALFORMED_INPUT` without effect.

Retrieved and model content is data only. Machine flags for requested policy mutation and authority escalation deny before consent or projection. The evaluator does not inspect prose for permission and cannot accept retrieved/model values as policy. Memory candidates that request authority are poisoning attempts and are denied; later candidate/outbox consumers must still require classification, verification, confirmation, and cited settlement as defined in `contracts.md`.

## Deterministic outcomes and future consumers

The evaluator returns only `allow`, `deny`, `require_confirmation`, `redact`, or `abstain`. Every denial/abstention has a stable machine reason; confirmation has a gate ID. The current evaluator is a library seam, not a running enforcement service. Todos 13-18 must call it for connector/context decisions, todos 27-30 for memory feedback/export/delete, todo 33 for notifications, todos 34-35 for remote principal isolation, and todo 36 for transfer/restore operations. Those consumers must parse this shipped config at startup, fail closed on parse/version errors, and retain all existing authority, filesystem, redaction, receipt, fence, and verification checks.
