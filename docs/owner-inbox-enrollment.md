# Owner inbox enrollment

The inbox does not sign on a CSRF session or a Tailscale-User-Login header. Those are pre-filters only.

Enrollment is a one-time code, not a standing secret in the client:

1. jarvis-svc runs `node dist/src/owner-inbox-enrollment-main.js --db <authority.sqlite>`. It prints a one-time code and stores only its hash, with a 10 minute expiry. The code is not written to chat, issues, or logs by the command.
2. 오모냥 relays that code to the owner in Slack.
3. The owner, on the phone that should approve, enters the code in 승인함 → 패스키 등록. The phone gateway signs the request. The dashboard admits GET `/api/v1/owner-inbox` and POST `/enroll`, `/challenge`, and `/decide` only when method and path match, and binds origin and rpId to the signed `public_origin`. A loopback dashboard session still uses `JARVIS_OWNER_INBOX_ORIGIN` or the bind URL. The page POSTs `{ phase: "options" }`, creates the passkey, then POSTs the attestation. The server stores only the credential id and public key, then marks the code digest used. A second use is rejected. A wrong origin is `OWNER_INBOX_ORIGIN_MISMATCH` and is audited.
4. Every later approve or reject must present a fresh WebAuthn assertion. The challenge binds that request id, decision, digest, and a 120 second expiry. The server verifies the assertion before the owner decision key signs. A replayed assertion is rejected and audited.
5. Every attempt, including rejection and failure, writes `owner_inbox_attempt`.

Header identity never replaces the assertion.
