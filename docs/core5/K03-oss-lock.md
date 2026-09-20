# K03 — Core5 OSS supply-chain / isolation / budget lock

**Status:** locked (docs only)  
**Date:** 2026-09-20  
**Engine:** no production-engine change. No new `package.json` production dependencies.

Machine table: [`k03-oss-lock.json`](./k03-oss-lock.json).

## Scope

Eleven Core5 OSS candidates this JARVIS repo already uses or proposes. Pins are taken from this worktree's `package-lock.json` when present; proposed-not-installed rows are registry/image observations only and are **not** adopted.

Test toolchain stays outside the Shipping runtime. Docling and ClamAV remain least-privilege process notes. J04 / live Mail send is still HOLD.

## Duplicates vs `package.json`

| Candidate | `package.json` | Lock pin | Duplicate? |
| --- | --- | --- | --- |
| jose | absent | 6.2.12 via `@modelcontextprotocol/sdk` | yes — do not add a direct dep |
| zod | `4.1.5` | 4.1.5 | no |
| better-sqlite3 | `^12.2.0` | 12.11.1 | no (range vs lock pin) |
| @modelcontextprotocol/sdk | `1.30.0` | 1.30.0 | no |
| @simplewebauthn/server | `^13.3.3` | 13.3.3 | no |
| vitest | `^3.2.4` (dev) | 3.2.7 | no |
| @playwright/test | `1.62.1` (dev) | 1.62.1 | no |
| ClamAV | absent | n/a | not installed |
| Docling | absent | n/a | not installed |
| OpenTelemetry | absent | n/a | not installed |
| DBOS | absent | n/a | not installed; J05 not adopted |

## Pins

### 1. jose — in lockfile (transitive)

- Version: `6.2.12`
- Commit: `505a55b8f73536082367b2614cb77e927ba96ec1` (github.com/panva/jose tag `v6.2.12`)
- LICENSE: MIT
- Tarball: `https://registry.npmjs.org/jose/-/jose-6.2.12.tgz`
- Integrity: `sha512-9NiFmJEex0sy2Dk58j2UGBSHgUs2ypF9eZSu4L6vjOX3Dp96Sw1F3uL+H+D1sx02jZZdzUT0HgvCy59CuvXcWw==`
- Image digest: none
- Shipping runtime: no (library only; pulled by MCP SDK)

### 2. zod — production direct

- Version: `4.1.5` (exact in `package.json`)
- Commit: `780cf57167cbf3902efab68f19fa21ca09cb9dd6`
- LICENSE: MIT
- Integrity: `sha512-rcUUZqlLJgBC33IT3PNMgsCq6TzLQEG/Ei/KTCU0PedSWRMAXoOUN+4t/0H+Q8bdnLPdqUYnvboJT0bn/229qg==`

### 3. better-sqlite3 — production direct

- Version: `12.11.1` (range `^12.2.0`)
- Commit: `4cbc39ca582fecb6b51dd920dfdd338ba4b72230`
- LICENSE: MIT
- Integrity: `sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==`

### 4. @modelcontextprotocol/sdk — production direct

- Version: `1.30.0`
- Commit: `2d889f2b329e46680ec9bdd565de4616c497825a`
- LICENSE: MIT
- Integrity: `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==`

### 5. @simplewebauthn/server — production direct

- Version: `13.3.3` (range `^13.3.3`)
- Commit: `6f9a2d49f6bd0b1f53faccc5cd4188ac930af2af`
- LICENSE: MIT
- Integrity: `sha512-LelX/lcy5cjc15A86i/aNxHhB5eU7dd20QsbP0VLAf9e38+SLlsnqCCyecx3xqfGofhmX05h1J9fKRYWxw+luA==`

### 6. ClamAV — proposed, not installed

Least-privilege process notes only. Do not load `libclamav` into the JARVIS Node process. Do not add an npm wrapper.

- Observed image: `docker.io/clamav/clamav:1.5-debian`
- Digest: `sha256:cc16781fe005e49de6a8fc1231b63b265f74b18fc2a6347c670c35716914c3b6` (hub, 2026-09-14)
- LICENSE: GPL-2.0-only (`COPYING.txt` on Cisco-Talos/clamav)
- Isolation: separate uid, no JARVIS DB mount, stdin/file descriptor for scan bytes only, no outbound except optional `freshclam` (disabled)
- Shipping runtime: no

### 7. Docling — proposed, not installed

Least-privilege process notes only. Do not import into JARVIS.

- Observed PyPI: `docling 2.129.0` wheel `docling-2.129.0-py3-none-any.whl`
- sha256: `9541a7dcd80f24cbe73033c9b72240d0760b392b18ce45ea8165014fc9f6cbcb`
- LICENSE: MIT (upstream `LICENSE` at tag `v2.129.0`)
- Isolation: dedicated process, no JARVIS secrets, no GPU/cloud model endpoints, cwd scratch only, bounded CPU/RSS, stdout JSON
- Shipping runtime: no

### 8. OpenTelemetry — proposed, not installed

Do not add `@opentelemetry/*` to production `package.json` in this lock.

- Observed JS API: `@opentelemetry/api 1.9.1` commit `7e74509a4d848e94b2970b5262dd3e8efeed0a2` Apache-2.0
- Observed collector image: `docker.io/otel/opentelemetry-collector-contrib:0.161.0`
- Digest: `sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1` (same as hub `latest` on 2026-09-16)
- Shipping runtime: no

### 9. DBOS — proposed, not adopted

See `docs/adr/core5-j05-dbos-compare.md`. Do not install.

- Observed npm: `@dbos-inc/dbos-sdk 5.0.2`
- Commit: `1cf44a1dacc359316f75898ae7ed7a65302f4919`
- LICENSE: MIT
- Integrity: `sha512-I5yH/rYlvBaQKG13sDa9CRQINvyedG8P6XJGzM0Z7yriApKGknbY+/lhyeTgEb721GNb0tb4dYFTVu+99gQoFw==`
- Shipping runtime: no

### 10. vitest — test toolchain (dev)

Outside Shipping runtime.

- Version: `3.2.7` (range `^3.2.4`)
- Commit: `c0c203db7ae2948536ad54f93e3a2b168334e245`
- LICENSE: MIT
- Integrity: `sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==`

### 11. @playwright/test — test toolchain (dev)

Outside Shipping runtime. Chromium for E2E is not a production image.

- Version: `1.62.1`
- Commit: `26a9e470a7b3c7822084b09fb7f13902c5f37b51`
- LICENSE: Apache-2.0
- Integrity: `sha512-DTcUc8qii+cpHvtOwggMtBRMjKZHXYWdw8syRYu2vtzuq4Wxphqq4NfCs5Zt44L6mA8rfDfj+PHnxFc/FeK6mQ==`

## Isolation

- Shipping runtime may load only production `package.json` + lockfile closures already present.
- Vitest, Playwright, ESLint, TypeScript, Vite, jsdom, Testing Library, fast-check, axe-core stay `devDependencies`.
- ClamAV/Docling: spawn-only notes; no in-process binding; no JARVIS SQLite/key paths.
- CORE5_INTEGRATION_ENABLED remains default off.

## External service / model budget

| Call | Purpose | Allowed in Core5 runtime | Cost |
| --- | --- | --- | --- |
| npmjs registry | install-time only | no | 0 USD / request |
| ClamAV freshclam | signatures, if sidecar ever enabled | no (disabled) | 0 USD |
| Docling / IBM document APIs | none | no | 0 USD; 0 tokens |
| OTel vendor backends | none | no | 0 USD |
| DBOS Cloud | none (not adopted) | no | 0 USD |
| hosted LLM / embeddings | none on Core5 path | no | 0 USD; 0 tokens |

## SBOM

This lock **is** the Core5 candidate SBOM: 11 rows with version, commit or image digest, license, and npm integrity where applicable. Full-tree CycloneDX of `node_modules` is out of scope (would include every transitive of Electron/Playwright).

## Non-goals

- Do not install ClamAV, Docling, OTel, or DBOS.
- Do not start J04 (blocked on Mail M04).
- Do not push, merge, or deploy.
