> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# migrations/ — immutable SQLite authority schema

Score 13 (110 SQL files; table names are the public surface; `authority_revocations` / `verification_evidence` / `memory_outbox` hubs). Distinct from parent “new file, never edit bytes”: journal mechanics live here.

## OVERVIEW
Forward-only SQLite DDL applied by `MigrationStore.migrate()`; `schema_migrations.id` is the **filename**, checksum SHA-256 of exact bytes.

## WHERE TO LOOK
| Cluster | Files | Notes |
|---------|-------|-------|
| Authority core | `001`–`009` | `schema_migrations`, receipts, purposes/revocations |
| Live/GJC | `010`–`017` | pre-GJC + live supervisor + GJC runtime |
| Control/workflow | `021`–`027` | `control_command_*`; `026` blocks collab writes |
| Personal/daily | `032`–`037` | `033` daily loop + first memory outbox |
| Memory sagas | `038`–`057`, `070`–`080` | outbox rebuilt `039`/`041`/`057`; cancellation `072`–`076` |
| Task pipeline | `058`–`064` | artifacts, certifications, git pubs, completions |
| Remote auth v2 | `056`, `081`–`083` | quarantines `033` WebAuthn tables |
| Local retention | `089`–`096` | write-once digest/claim identity |
| Apply | `src/migration-store.ts` | `readdir` + `.sql` lexicographic sort |
| Dist copy | `scripts/copy-migrations.mjs` | whole dir → `dist/migrations` |

## CONVENTIONS
- Grammar `NNN_snake.sql`. Prefixes 001…N contiguous, **not unique**: duplicate prefixes are two journal rows.
- Apply order is **filename sort**, not numeric id (`074_memory_*` before `074_retention_*`).
- Duplicate prefixes on disk: `028`, `072`, `073`, `074`, `075`, `079`, `080`, `097` (two each); `098` has three.
- `055_memory_candidate_authority_v6.sql` is `SELECT 1;` (`056` shipped first; rebuild is `057`).
- Rebuild pattern: `RENAME TO *_vN` → `CREATE` live name → `DROP` old. Task30 recovery special-cases `042` and `045`.
- Immutability via `BEFORE UPDATE/DELETE` `RAISE(ABORT,…)`. RFC3339 millis timestamps; `json_valid` on JSON; digests `sha256:`+hex.

## ANTI-PATTERNS
- Checksum mismatch → `MIGRATION_CHECKSUM_MISMATCH`; unknown applied id → `MIGRATION_VERSION_UNSUPPORTED`.
- Do not treat the 3-digit prefix as the journal key.
- `058`: REPLACE can bypass DELETE triggers; uncertain attempts have no replay transition.
- `089`: recovery never deletes a candidate by name; retention rows are not deleted.
- No `migrate` npm script; opening `AuthorityDb` applies.
