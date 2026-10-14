# Read-only messenger inbox summary

The messenger connector reads an aggregate file exported from the Omoyang Slack
durable inbox. It never opens the inbox DB, Slack credentials or message bodies.
It exposes only `incomplete_count`, `oldest_incomplete_age_ms` and `observed_at`.
Tracking: [Issue #86](https://github.com/whelp99-code/Orca-JARVIS/issues/86).

## Source and separate exporter

`/home/jm/.omo/omonyang/inbox.mjs` stores `events` with JSON `payload`, `state`
and epoch-millisecond `received`. Acknowledgement/delivery is not completion:
only `completed` is finished. The listener can accept users other than the
representative, so the exporter requires an explicit representative Slack user
ID. It must be supplied by the operator, not inferred from a channel or the
first inbox row.

The separate `scripts/export-messenger-summary.mjs` opens the inbox readonly
and uses SQLite's online backup API to materialize one consistent private
scratch database, then aggregates the representative's human `pending` and
`processing` events from that copy. The live inbox is not written and no
rollback journal is created on the source path.
Completed records, other users, bots and message edit/delete notifications are
excluded. Age is based on local durable receipt time, not the Slack message
timestamp. Neither `inbox.mjs` nor its listener is changed or imported.

Operator invocation after approval, from the JARVIS checkout/release containing
the script (shell variables below are operator-supplied, not stored secrets):

```sh
node scripts/export-messenger-summary.mjs \
  --inbox "$INBOX_DB" \
  --representative-user-id "$REPRESENTATIVE_SLACK_USER_ID" \
  --output "$MESSENGER_SNAPSHOT_FILE"
```

No body, identity, event ID, channel, evidence string or DB path is emitted.
Success/error output uses fixed codes. Invalid source data is a failed export,
not an empty inbox. A failure before atomic replacement retains the previous
snapshot, which the consumer will reject once expired. A directory-fsync failure
after replacement may leave the new complete file but reports publication failure;
no partial JSON is published.

The file contract is exactly:

```json
{
  "schema_version": 1,
  "observed_at": "2026-10-13T00:00:00.000Z",
  "incomplete_count": 2,
  "oldest_incomplete_age_ms": 300000
}
```

The example is synthetic. A successful empty export has count `0` and age
`null`. Counts/ages must be nonnegative safe integers, and count/age emptiness
must agree. The exporter copies the inbox into scratch, then captures one
observation time for aggregation and writes atomically:
exclusive temporary file, exact `0640`, file fsync, rename, directory fsync.
It does not create or mutate the inbox, claim/complete work, send anything, or
generate keys.

## File permission and deployment boundary

The output directory must already exist, be owned by the producer UID, have no
symlink components and no group/world write permission. The output must be a
regular, non-symlink `0640` file owned by that UID. Use a dedicated directory
with a reader group, for example mode `2750` and a group shared with the JARVIS
service; setgid inheritance gives new atomic snapshots the correct group.
The JARVIS service needs traversal and read access to this directory/file only,
not the inbox directory, SQLite WAL/SHM or Slack token files.
Both paths must be canonical absolute paths, without `.` or `..` aliases;
source DB, WAL, SHM and rollback-journal paths cannot be publication targets.
Packaged runtime releases include `scripts/export-messenger-summary.mjs` beside
the existing operator scripts so the documented command works from
`/opt/jarvis-runtime` checkouts.

The operator chooses and provisions the directory, group membership and
representative ID after review. Refresh the snapshot more frequently than
60 seconds (for example every 30 seconds) using approved scheduling. This PR
does not install a service/timer, change groups or ACLs, export the operating
inbox, restart services or deploy anything. A working synthetic proof is not
operating adoption.

## JARVIS configuration and behavior

Public registry configuration accepts:

```json
{
  "messenger": {
    "snapshot_file": "/var/lib/omonyang-summary/messenger.json",
    "producer_uid": 1000
  }
}
```

The path/UID are examples; pin the actual producer UID, not the reader's UID.
Dashboard opt-in uses both `JARVIS_MESSENGER_SNAPSHOT_FILE` and
`JARVIS_MESSENGER_PRODUCER_UID` (decimal UID). Missing/invalid UID with a
configured path is a configuration error. Without a path, messenger remains
`configured:false`; a configured but missing/unreadable snapshot is unavailable.

Only `messenger.summary.read` is granted. The reader verifies directory/file
ownership and permissions, refuses symlinks/nonregular files, bounds reads to
4 KiB and parses a strict aggregate schema. Extra/private fields, invalid
timestamps, negative counts, future observations and snapshots older than
60 seconds fail closed. Within the freshness window, the reported oldest age
adds elapsed milliseconds since export. `observed_at` still identifies the
source observation; freshness never extends merely because JARVIS rereads it.

`GET /api/v1/connectors/messenger` requires the existing local same-origin and
`x-jarvis-csrf` session boundary. It rejects query overrides and writes before
reading the source. Responses use `Cache-Control: no-store`.
Complete empty snapshots map to `no_data`; failed reads map to `unavailable`
with no values, never fabricated zero counts. Both registry and HTTP reads
remain stateless, with `checkpoint:null` and null session handles. Explicit
well-formed start/continue requests allocate no slot; malformed checkpoint
envelopes are rejected. Mail and the four legacy checkpoint holders retain
their existing behavior.

## Verification

Related tests cover the real exporter with a synthetic SQLite inbox, immutable
source state, exact permissions, filtering, malformed data, safe atomic output;
the snapshot reader's age/freshness/permissions/privacy boundary; 100 stateless
reads alongside four occupied legacy slots; and the protected dashboard HTTP
happy/empty/unavailable/unconfigured/rejected-request cases.

The task's retained `.omo/evidence/messenger-20261013/qa.mjs` runs the actual
exporter and compiled JARVIS HTTP entry point against isolated synthetic data,
records sanitized HTTP/CLI receipts and removes its temporary DBs/files/servers.
Run with the project's pinned Node 24. No operating message data or keys are
needed for verification.
