# Read-only calendar summary connector design

Status: design only, 2026-10-13. Tracking: [Issue #84](https://github.com/whelp99-code/Orca-JARVIS/issues/84).
Request: `TASK-JARVIS-CALENDAR-20261013`.

## Source audit and decision

The current Mail integration does not provide a verified calendar source.
Follow the request's no-source branch: publish this design only. Keep JARVIS
`calendar` unconfigured. No Mail implementation PR, permission change, key
creation, OAuth flow, production request, deployment, or merge belongs to this
increment. A working calendar connector is **not** claimed.

The audit used Mail remote `main` at
`4d70a3d51e1ecc814840352163ff1c50373ea5df`, not its older, dirty canonical
checkout. JARVIS starts at `7740f678284478d7c6eb6607cd4cd320544e622e`
(merged PR #78). On host `jm-omachy`:

| Evidence at the pinned Mail commit | Finding |
| --- | --- |
| [`src/safety.js:74-78`](https://github.com/whelp99-code/mail-intelligence/blob/4d70a3d51e1ecc814840352163ff1c50373ea5df/src/safety.js#L74-L78) | `delegatedScopesForSafety` requests `openid profile offline_access User.Read Mail.Read`; optional flags add only `Mail.Send` and `Mail.ReadWrite`. |
| [`src/security/safety-policy.js:17-20`](https://github.com/whelp99-code/mail-intelligence/blob/4d70a3d51e1ecc814840352163ff1c50373ea5df/src/security/safety-policy.js#L17-L20) | The other scope constructor also has no calendar permission. |
| [`server.mjs:116`](https://github.com/whelp99-code/mail-intelligence/blob/4d70a3d51e1ecc814840352163ff1c50373ea5df/server.mjs#L116), `:1446`, `:2365`, `:3018` | Authorization, refresh and code exchange all use `delegatedScopes`. |
| [`server.mjs:1474-1478`](https://github.com/whelp99-code/mail-intelligence/blob/4d70a3d51e1ecc814840352163ff1c50373ea5df/server.mjs#L1474-L1478) | Client credentials separately request `https://graph.microsoft.com/.default`; that literal does not prove any calendar application role. |
| `src/adapters/microsoft-graph-mail.js`, `src/adapters/microsoft-graph-send.js` | Existing Graph adapters cover mail, not a calendar source. Tracked-source search found no `Calendars.Read`, `Calendars.ReadBasic`, or `Calendars.ReadWrite` literal or calendar-view reader. |
| [`src/security/jarvis-mail-reader.js:48-63`](https://github.com/whelp99-code/mail-intelligence/blob/4d70a3d51e1ecc814840352163ff1c50373ea5df/src/security/jarvis-mail-reader.js#L48-L63) | Mail PR #61's service reader admits only exact `GET /api/storage/status`, not calendar reads. |

Mail's calendar suggestions extracted from messages are not authoritative
Outlook events. The existing storage-status API supplies message/thread counts,
not calendar counts.

Configuration names inspected in source/templates include
`MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
`OUTLOOK_GRAPH_ACCESS_TOKEN`, `OUTLOOK_MAILBOX_USER`,
`MAIL_INTELLIGENCE_GRAPH_BASE_URL`, `MAIL_INTELLIGENCE_GRAPH_TIMEOUT_MS`,
`MAIL_INTELLIGENCE_GRAPH_PAGE_SIZE`, and `MAIL_INTELLIGENCE_GRAPH_MAX_PAGES`.
Neither `.env.example` nor `.outlook-config.json.example` declares a calendar
scope option. Names alone are not evidence that values are configured.

No token, secret configuration value, customer data, or calendar content was
opened or printed. Existing granted `scp`/`roles`, consent in Entra, the active
authentication mode, and the deployed Mail revision remain **unverified**.
Previously granted permissions might exist outside this code; this audit does
not assert their absence. There is still no confirmed usable calendar path.

## Permission requirement and alternatives

Microsoft's [calendarView API](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
lists delegated `Calendars.ReadBasic` as its least-privileged permission for a
work/school account. It suffices for event timing; `Calendars.Read` also permits
the read but is broader. `Mail.Read` does not grant calendar access.

Preferred future option: opt in to `Calendars.ReadBasic` for one explicitly
bound company mailbox's default calendar. If the operator chooses
`Calendars.Read`, record why the broader scope is needed. Updating requested
scopes does not itself grant consent: operator-approved reauthorization and a
sanitized successful calendar read must precede a connection claim. Keep send,
mail-mutation and calendar-write capabilities disabled.

Alternatives, not automatic fallbacks:

- A dedicated application reader can use an approved calendar application
  permission with mailbox-restricted access. `.default` is only a request for
  preconfigured roles; admin consent and the exact mailbox boundary must be
  verified separately. Use `/users/{bound-mailbox}/calendar/calendarView`, not
  `/me`, for app-only access. This is a separate security decision.
- An operator-provided, authorized read-only calendar export could be a separate
  source. It needs recurrence/timezone handling, an explicit freshness contract,
  and protection of any private feed URL. No such export was found or claimed
  available here.
- Until a source is approved and verified, remain `configured:false`. Do not
  infer event counts from mail, scrape a human Outlook session, or present
  synthetic zeros as a connected calendar.

## Proposed Mail summary boundary

The following is a future contract, not an existing endpoint:
`GET /api/calendar/summary`, loopback only, no body or query parameters.
The server clock fixes the window and the bound account; callers cannot select
a mailbox, calendar, date, Graph host, fields, or paging link.

Return only counts and the next start time, with interpretation metadata:

```json
{
  "schema_version": 1,
  "observed_at": "2026-10-13T00:00:00.000Z",
  "timezone": "Asia/Seoul",
  "window_start": "2026-10-13T00:00:00+09:00",
  "window_end": "2026-10-15T00:00:00+09:00",
  "today_count": 2,
  "tomorrow_count": 1,
  "next_event_at": "2026-10-13T01:00:00.000Z"
}
```

This example is synthetic. Counts are nonnegative safe integers;
`next_event_at` is a UTC timestamp or `null`. Both count buckets and the next
start search cover **today and tomorrow only**, not an unlimited future search.
`null` means no not-yet-started event in this window, not no future appointments.
`observed_at` is the producer observation time, not a sync cursor or revision.

Use fixed KST (`UTC+09:00`), matching JARVIS daily-loop policy. The window is
half-open: today's midnight inclusive through the day-after-tomorrow midnight
exclusive. Each day's count includes non-cancelled occurrences overlapping that
day: `start < day_end && end > day_start`. An event spanning midnight counts
once in each overlapping day. All-day events follow the same exclusive-end
rule; an instantaneous event counts on its start date. End-before-start or
unparseable times fail the entire read. Recurring occurrences and exceptions
come from `calendarView`, not a count of recurrence masters.

The next start is the earliest non-cancelled occurrence with
`observed_at <= start < window_end`; an already ongoing event is counted but
is not a next start. Future all-day events participate at their start midnight.
Cancelled events are excluded; other invitation response states are included.
The UI/consumer must retain this documented meaning.

For delegated access, issue only GET:

```http
GET https://graph.microsoft.com/v1.0/me/calendar/calendarView?startDateTime=2026-10-13T00%3A00%3A00%2B09%3A00&endDateTime=2026-10-15T00%3A00%3A00%2B09%3A00&$select=id,start,end,isAllDay,isCancelled&$top=1000
Prefer: outlook.timezone="UTC"
```

This is a future example, not an executed request. Explicit offsets determine
the query window; `Prefer` controls returned time zones, not query boundaries.
Event IDs exist only transiently to deduplicate occurrences across pages.
Never return/log/persist IDs, subjects, bodies, locations, organizers, attendees,
customer names, meeting links, tokens, or upstream response bodies.

Follow `@odata.nextLink` only on the pinned HTTPS Graph origin and the same
bound calendar-view path; reject credentials, fragments, foreign origins,
redirects and repeated links. Complete all pages before returning a summary.
Use explicit per-read budgets (proposal: 5 seconds total, 10 pages, 2 MiB total);
overflow, timeout, malformed data, or incomplete paging is unavailable, never
a partial success or zero count. No retries within a summary request.

Use `Cache-Control: no-store` on success and failure. Missing/invalid reader
authentication is 401; mixed authority, wrong method/path or query is 403.
Unavailable source or missing calendar consent is 503 with a fixed public error
code and no counts. A successful empty window is 200 with both counts zero and
`next_event_at:null`. Do not translate Graph 401/403/429/5xx into empty data.
Graph credentials and their operator-approved lifecycle stay inside Mail;
JARVIS never receives them or triggers a human login/consent flow.

## Dedicated service authentication

Follow [the existing Mail connector](mail-read-connector.md) and
[Mail PR #61](https://github.com/whelp99-code/mail-intelligence/pull/61):
`x-api-key`, `x-principal-id`, `x-principal-kind: service`,
`Accept: application/json`. No invented signature or nonce.
No Cookie, Authorization, `x-workspace-id`, or human-session fallback on the
JARVIS-to-Mail hop. The Mail-to-Graph hop uses its own Graph bearer credential.

Create a **separate future calendar reader** with default principal
`jarvis-calendar-summary-reader`. Do not widen the existing
`jarvis-mail-summary-reader` or reuse its key. A pre-route machine-auth
dispatcher must distinguish the two principal bindings without falling through
to human auth. Each binding admits exactly its own method/path; a Mail key
cannot read calendar data and a calendar key cannot read mail, send, sync,
OAuth, storage administration or unrelated routes.

Proposed opt-in names (not implemented):

| Producer | Consumer |
| --- | --- |
| `MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED` | optional `calendar` config object |
| `MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_PRINCIPAL_ID` | `calendar.reader_principal_id` / `JARVIS_CALENDAR_READER_PRINCIPAL_ID` |
| `MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_KEY_FILE` | `calendar.reader_key_file` / `JARVIS_CALENDAR_READER_KEY_FILE` |
| Existing operator-bound Graph account | `calendar.base_url` / `JARVIS_CALENDAR_BASE_URL` |

Consumer base URL must be an `http://127.0.0.1` root with no userinfo, query or
fragment. Reuse the existing process-owned, regular, non-symlink, exact-`0600`
absolute credential-file boundary and printable-ASCII length/byte limits.
Reject missing/insecure/malformed credentials before HTTP. Key provisioning
and principal registration are later operator actions, not part of this PR.

## Proposed JARVIS connector

Add a `calendar` source following `MailPersonalConnectorSource`, with only
`calendar.summary.read` and allowed values `today_count`, `tomorrow_count`,
`next_event_at`, `observed_at`, `timezone`, `window_start`, `window_end`.
Validate the producer shape, numeric bounds, date window and timestamp
consistency before projecting this allowlist.

The future dashboard endpoint is protected
`GET /api/v1/connectors/calendar`, with the same-origin and `x-jarvis-csrf`
checks used by Mail. Reject query overrides and writes before upstream access.
No UI or browser source selection is authority.

Use stateless reads: `checkpoint:null` and
`checkpoint_session:{mode:"stateless",handle:null}`. Well-formed start/continue
requests allocate no handle; malformed checkpoint envelopes still fail.
The four legacy checkpoint slots and Mail's stateless behavior must not change.
No calendar DB tables, migration, cache, polling worker or persistent Graph
pagination cursor is needed for this bounded summary.

No config means `configured:false`/`not_configured`. Valid config is not proof
of connectivity. A complete empty response becomes `no_data`; unavailable or
invalid producer output becomes `unavailable` with no values. Nonempty counts
remain valid when `next_event_at` is null because events may already have
started. Do not claim upstream freshness from a local read timestamp.

## Future implementation acceptance (not executed here)

After operator source approval, open one Mail PR for the producer and one
JARVIS PR for the consumer. Use fixed public synthetic credentials and an
isolated Graph fixture, never an operating key or mailbox. Capture actual HTTP
status, sanitized header names, allowlisted bodies, call counts and cleanup.

1. At fixed clock `2026-10-13T00:00:00.000Z`, invoke
   `fetch("http://127.0.0.1:43110/api/calendar/summary", {headers: readerHeaders})`
   against the isolated Mail server. Fixture starts at 08:00 and 10:00 KST today
   and 09:00 tomorrow must produce 200/no-store, counts 2/1 and next start
   `2026-10-13T01:00:00.000Z`, with only the documented fields. `readerHeaders`
   contains the four service headers above and a fixed public fixture key.
2. Repeat that exact call with empty, midnight-spanning, all-day, cancelled,
   recurring-exception and multi-page fixtures. Assert exact expected buckets,
   exclusive window-end behavior and no duplicate counting. A malformed time,
   foreign nextLink, paging cap or Graph 403/429 must produce an unavailable
   response, no partial counts and no redirected request.
3. Invoke the same URL without headers, with conflicting Cookie, with the Mail
   principal, with `?mailbox=other`, and with `method:"POST"`. Assert the
   designated 401/403 and zero Graph calls. Calendar credentials against
   `/api/storage/status` and send routes must be rejected too.
4. Obtain a synthetic local JARVIS session through
   `fetch("http://127.0.0.1:43173/api/v1/session")`; use its CSRF token in
   `fetch("http://127.0.0.1:43173/api/v1/connectors/calendar",
   {headers:{"x-jarvis-csrf":csrf}})`. Assert ready/no_data/unavailable mapping,
   no-store, allowlisted values, stateless/null checkpoints, no upstream call
   for missing/unsafe key files, and no redirect/session fallback.
5. Preserve neighboring `tests/unit/personal-connector-mail-source.test.ts`
   (100 cycles and concurrent legacy checkpoint holders) and
   `tests/integration/dashboard-mail-summary.test.ts` (protected Mail HTTP)
   unchanged and green. Add calendar cases beside them; run related
   tests/types/lint only. Close all fixture servers/DBs, remove temporary
   credentials, and record that owned ports are released.

This design was checked against the cited source and official API contract.
No future scenario above is reported as a passing runtime test. Permission
consent, deployed identity, real mailbox reads and operating adoption are
separate evidence gates after Cursor review.
