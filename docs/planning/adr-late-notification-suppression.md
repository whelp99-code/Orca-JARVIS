# Late notification suppression

Decision: reconcile notification lifecycle state with memory suppression and quarantine in the same authority transaction as notification lineage mutations. Also reconcile on notification claim/settle to cover persisted late links from earlier versions. No migration bytes are changed.

Reproduction at 4c483a1: canonical backend runner, notification-delivery.test.ts, 9 passed / 2 failed. Quarantining either the intent or delivery after claim leaves both rows delivering.

Blocked pending intents become suppressed; blocked delivering rows and their owning delivering intents become failed. Terminal outcomes and receipts remain unchanged. Claim rechecks its delivery after lineage inheritance before returning a payload. A contradictory delivered acknowledgment remains a replay conflict. As with existing reconciliation, a throwing settle transaction rolls back its changes; a subsequent successful claim persists reconciliation. Such a rejected acknowledgment cannot promote a blocked delivery.

External notification recall, provider deletion, and propagation of new parent dependencies to already-created descendants remain outside this correction. No production restart or database mutation is authorized here.

Validation: canonical backend runner, 8 files / 48 tests passed (notification delivery, dashboard notification API, notification intents, projection authority, parent bindings, late subjects, readiness, readers). Typecheck, lint, backend build and diff whitespace check exited 0. Compiled two-process SQLite smoke reopened the file and rejected a delivered acknowledgment after quarantine, returned no repeated claim, and retained a null receipt. External notification provider calls: 0; native OS display/recall is not validated by this smoke. Full verify remains pending separately.

Fixed-clock pre-GJC acceptance and CLI smoke exited 0. Native read-only review /root/late_notification_review returned ship with no findings. Requested model/effort: gpt-5.6-terra/high; realized settings unobservable. Residual: created/queued delivery rows are transient within the normal claim transaction; this change does not add a separate repair path for manually persisted intermediate delivery states.
