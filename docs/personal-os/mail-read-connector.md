# Read-only Mail connector

The personal `mail` connector reads Mail Intelligence's protected
`GET /api/storage/status` API. It exposes only global storage message/thread
counts and the local observation time. It does not claim mailbox-scoped counts,
sync freshness, or upstream cursor support.

Public registry configuration adds an optional `mail` object:

```json
{
  "mail": {
    "base_url": "http://127.0.0.1:3010",
    "reader_key_file": "/var/lib/jarvis-svc/config/orca-jarvis/mail-reader.key",
    "reader_principal_id": "jarvis-mail-summary-reader"
  }
}
```

The reader key must be separately issued for Mail's summary-only service
principal. It must be a regular, non-symlink, process-owned `0600` file. No secret
value belongs in an environment variable, URL, log, or checked-in configuration.
The proposed operator path is `/var/lib/jarvis-svc/config/orca-jarvis/mail-reader.key`,
owned by `jarvis-svc`. No operational key is generated or copied by this change.
An absent, insecure or malformed key is unavailable before any HTTP request.
The key value must be printable ASCII of 32–4096 characters; file size is at most
4098 bytes, matching Mail's private-file contract.

The dashboard reads `JARVIS_MAIL_READER_KEY_FILE` and optional
`JARVIS_MAIL_READER_PRINCIPAL_ID` (default `jarvis-mail-summary-reader`) and
`JARVIS_MAIL_BASE_URL` (default `http://127.0.0.1:3010`). Its protected
`GET /api/v1/connectors/mail` endpoint uses the existing same-origin and
`x-jarvis-csrf` boundary. Configuration is not proof of a successful connection.
Without configuration, `configured:false` remains visible.

Mail PR61's authentication headers are `x-api-key`, `x-principal-id`,
`x-principal-kind: service`, and `Accept: application/json`. No request signature
or nonce is used. Cookie, Authorization and x-workspace-id are never sent;
mixed authority is rejected by Mail. Redirects and authentication refusals are
unavailable, never retried, followed or replaced with a human session.
`mail.session_file` is removed and `JARVIS_MAIL_SESSION_FILE` is ignored.

The public registry grants only `mail.summary.read` and allows
`message_count`, `thread_count`, and `observed_at`. Send, draft, Graph sync,
and mail state APIs are never called or enabled.

Mail reads are always stateless: `checkpoint` and the session handle are null.
Well-formed explicit `start` or `continue` requests return a stateless session
without allocating or resolving a handle. Malformed checkpoint payloads are
still rejected. Closing a Mail reader discards its result; no server handle
needs release. The four existing connector checkpoint slots are unaffected.

Operating note: set `JARVIS_MAIL_READER_KEY_FILE` to the separately provisioned
service-owned `0600` reader key path and register the matching principal in
Mail's opt-in reader settings. Existing Mail `3010` and dashboard units/ports
are reused. Key issuance, provisioning, registration and deployment remain
operator work after review; no session-cookie fallback is permitted.
