> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# contracts/ — frozen Second Brain MCP / scoped JSON

Score 9 (23 frozen MCP/scoped files in a 34-file tree; byte+sidecar dual pin; `second-brain-mcp-v1.json` highest inbound). Not JS modules.

## OVERVIEW
Frozen UTF-8 JSON snapshots plus `<name>.json.sha256` sidecars; loaded by `src/second-brain-transport-contract.ts` `loadSecondBrainContract`.

## WHERE TO LOOK
| Profile | File | schema |
|---------|------|--------|
| `task32-schema4` (default) | `second-brain-mcp-v1.json` | 4 |
| `remember-schema5` | `second-brain-mcp-v3.json` | 5 |
| `cancellation-schema6` | `second-brain-mcp-v4.json` | 6 |
| `cancellation-submit-schema7` | `second-brain-mcp-v5.json` | 7 |
| `scoped-record-read-v1`…`v5` | `second-brain-scoped-read-vN.json` | 1–5 |
| `scoped-request-write-v1` | `second-brain-scoped-write-v1.json` | 1 |
| `scoped-request-status-v1` | `second-brain-scoped-status-v1.json` | 1 |
| interop vector | `cancellation-result-v1.json` | pretty-printed; **no sidecar** |
| integration v1 | `integration/v1/*.schema.json` + `fixtures/*.golden.json` | `$id` schemas; not sidecar-pinned |
| finance read | `integration/v2/finance-read.schema.json` | no v2 fixtures |

No `second-brain-mcp-v2.json`. MCP file numbers skip 2; schema numbers are 4–7. The 23-file count is the frozen set (11 JSON + 11 sidecars + the cancellation vector), not `integration/` or this file.

## CONVENTIONS
- Sidecar: 64 lowercase hex + `\n`. JSON: sorted keys, compact separators, trailing newline (MCP `canonicalization`).
- Profile names are not filenames. Digests also hardcoded in `src/second-brain-contract.ts` / `second-brain-scoped-contract-digest.ts`.
- `scripts/copy-migrations.mjs` copies 22 files into `dist/contracts/` (everything except `cancellation-result-v1.json`).
- `scripts/sync-second-brain-contract.mjs` writes/checks **v1 only**; `--write` refuses dirty git; source must be absolute realpath, not a symlink.

## ANTI-PATTERNS
- Byte or sidecar mismatch → `SECOND_BRAIN_CONTRACT_MISMATCH`. Do not pretty-print MCP snapshots.
- Do not load across profiles or invent a v2 MCP file.
- `sb_remember.repeated_call` stays `non_idempotent_collision_safe_no_overwrite`.
- Scoped status is historical journal metadata only — not current-artifact or completion evidence.
- Do not treat `cancellation-result-v1.json` as a dist artifact.
