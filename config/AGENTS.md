> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# config/ — policy and schema JSON

Score 4 (13 JSON files; distinct policy domain; no executable entry). Parent covers the stack; this file is the policy map.

## OVERVIEW
Checked-in policy, examples, and JSON Schema 2020-12 documents. Nothing here starts a process.

## WHERE TO LOOK
| File | Role |
|------|------|
| `personal-os-policy.json` | live policy; `scripts/copy-migrations.mjs` copies this file into `dist` |
| `command-policy.json` | two argv allowlists, both `network: denied`, `filesystem: run-root` |
| `dashboard-runtime.schema.json` | requires `host` + `port` |
| `personal-os-runtime.schema.json` | requires `schema_version` + `mode` |
| `phone-gateway.env.schema.json` | public origin, owner login, session key file |
| `remote-approval.env.schema.json` | requires `rp_id` + `origin` |
| `release-compatibility.schema.json` | `schema_version` + `accepted_vector_digests` |
| `*.example.json`, `work-routing.preview.json` | samples, not the loaded policy |
| `portfolio-repositories.json`, `portfolio-status.json` | portfolio inputs, not authority rows |

## CONVENTIONS
- Schemas are draft 2020-12 with `additionalProperties: false`. Documents carry `schema_version`.
- `personal-os-policy.json`: `authority_host` is `linux-control-plane`. Gates include `mac_vault_transfer`, `linux_restore`, `export`, `deletion`, `sensitive_memory`.
- `command-policy.json` names `node scripts/personal-os-release-rehearsal.mjs` and `node dist/src/personal-os-backup-cli.js` only.
- Only `personal-os-policy.json` is on the dist copy list. Other files stay in the checkout unless a script names them.

## ANTI-PATTERNS
- Do not put `secret`, `raw_body`, `raw_screen`, `audio`, or `video` in personal-os fields.
- Do not treat an example or `work-routing.preview.json` as the policy the process loaded.
- Routing preview labels are not command strings or filesystem paths.
