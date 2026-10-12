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
    "session_file": "/absolute/private/mail-session"
  }
}
```

The session file contains the existing `mi_session` token, without a cookie
name, and must be a regular, non-symlink, process-owned `0600` file. No secret
value belongs in an environment variable, URL, log, or checked-in configuration.
This reader never issues sessions; the operator supplies an existing valid one.
Mail's current API has no session revocation endpoint. An expired/refused session
is unavailable, not an empty mailbox, and is never retried or renewed by JARVIS.

The dashboard reads `JARVIS_MAIL_SESSION_FILE` and optional
`JARVIS_MAIL_BASE_URL` (default `http://127.0.0.1:3010`). Its protected
`GET /api/v1/connectors/mail` endpoint uses the existing same-origin and
`x-jarvis-csrf` boundary. Configuration is not proof of a successful connection.
Without configuration, `configured:false` remains visible.

The public registry grants only `mail.summary.read` and allows
`message_count`, `thread_count`, and `observed_at`. Send, draft, Graph sync,
and mail state APIs are never called or enabled.

Mail reads are always stateless: `checkpoint` and the session handle are null.
Well-formed explicit `start` or `continue` requests return a stateless session
without allocating or resolving a handle. Malformed checkpoint payloads are
still rejected. Closing a Mail reader discards its result; no server handle
needs release. The four existing connector checkpoint slots are unaffected.

Operating note: supply the existing service-owned `0600` session-file path;
reuse the existing Mail `3010` and dashboard units/ports. Deployment and
credential provisioning remain operator work.
