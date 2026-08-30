# Joint runtime wiring evidence

Measured in `/home/jm/orca/workspaces/Orca-JARVIS/jarvis-terminal-memory-runtime` with Node `v24.19.0`, ABI `137`.

| Check | Result |
| --- | --- |
| `npm run runtime:check` | `JARVIS_RUNTIME_OK node=v24.19.0 abi=137` |
| `npm run lint` | exit `0` |
| `npm run typecheck` | exit `0` |
| `npm test` backend | `148` files, `965` tests passed |
| `npm test` dashboard | `20` files, `100` tests passed |
| `npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z` | `boundary=pre_gjc_ready aggregate_status=stopped completion_promoted=true gjc_dispatched=false` |
| `npm run build` | exit `0` |
| `node scripts/cli-smoke.mjs` | exit `0` |
| `runtime-wiring.test.ts` | `6` tests passed |
| daily/progress/jobs focused check | `19` tests passed |
| MCP executable stdio smoke | `3` responses, `9` tools; protocol `2025-11-25` |
| MCP malformed/oversize frame test | malformed `-32700`, oversize `-32600` |
| daily-control executable smoke | mode `once`, runs `0` |
| shell fallback persistence smoke | replay `true`, event `event:smoke` |
| shell fallback installer smoke | `enabled=false`; installed modes `0700` collector and `0600` hooks |
| migration 033 HEAD/worktree SHA-256 | `33e2755a78d87d281bfd3bfe7b18aed07ee3b93216f5131c4453329f169596b4` for both |
| provider child smoke | health `ready`, write accepted, request status `accepted`, version `fixture`, writable `true` |
