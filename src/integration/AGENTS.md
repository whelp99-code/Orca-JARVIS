> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# src/integration/ — Core5 read/draft boundary

Earned this file: score 9 (17 TS, `index.ts`, >10 exports, own flag). Distinct domain: the only nested package under flat `src/`.

## OVERVIEW
Optional Core5 integration. `isCore5IntegrationEnabled` is false unless `CORE5_INTEGRATION_ENABLED` is `1` or `true` (any case). `index.ts` re-exports this tree; nothing here imports `../index.js`.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Flag | `flag.ts` | default off |
| V1 envelopes | `schema.ts` | exact-key; `schema_version === 1`; audience `jarvis.integration` |
| Caller | `caller-context.ts` | rejects self-asserted permission keys |
| Capabilities | `capability-registry.ts` | registered read/status set |
| Synthetic reads | `synthetic-read-executor.ts` | `*.read`, `mail.status`, `cwos.state`, `memory.status` only |
| Mail mirror | `mail-draft-gateway.ts`, `mail-draft-card.ts`, `mail-draft-store.ts` | card mirror; human owns approve/send |
| Finance | `native-finance-read.ts`, `finance-read-gateway.ts` | Zod `.strict()`; `schema_version: 2` |
| CRM / owner | `native-crm-link.ts`, `native-owner-report.ts` | link is not money approval |
| Company archive | `company-archive-read.ts` | second-brain request/receipt domains |
| Ledger | `operation-ledger.ts` | missing-approval digest is the literal `none` |
| Cancel | `cancellation.ts` | external-effect window decision |

## CONVENTIONS
- Two wire generations: v1 command/result (`mail.read|mail.draft|mail.status|cwos.command|cwos.state|memory.request|memory.status|memory.read`) vs finance/native reads at `schema_version: 2` and `finance.read`.
- Validators are split: hand `keysOf` parsers in `schema.ts` / `caller-context.ts`; Zod `.strict()` in finance, CRM link, owner report, company archive.
- Digests are not one shape. Synthetic evidence is `sha256:` + `canonicalize` with no NUL domain. Company-archive uses `second-brain/company-memory-request/v1\0` and `second-brain/company-memory-receipt/v1\0`. Native finance body digest is raw SHA-256 of the response string.
- Clocks are injected on the mail gateway, native finance reader, and company archive reader.

## ANTI-PATTERNS
- Request keys `permission`, `permissions`, `authorized`, `roles`, `scopes` throw `CORE5_CALLER_SELF_ASSERTED_PERMISSION`. Audience must be `jarvis.integration`.
- `Core5MailDraftGateway.approve` / `send` / `cancel` return `never` (`CORE5_MAIL_HUMAN_OWNED`). Paths ending in `/approve` or `/cancel` are forbidden. Mail UI remains the review/approve/send surface.
- Synthetic executor never sends mail, mutates CRM, or writes Second Brain.
- `NativeFinanceReader` never authenticates, grants, writes, retries, or reconciles. Local delivery fence is not a native authority token. Discrepancy/settlement pin `read_only: true` and `live_source_checked: false`.
- `consumeNativeCrmLink` cannot approve money or issue authority.
