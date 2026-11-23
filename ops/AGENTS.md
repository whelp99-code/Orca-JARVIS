> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# ops/ — publish, portfolio, and key CLIs

Score 5 (16 files; distinct from `deploy/` units and from `scripts/` drivers). `src/` does not import this tree. These files call `dist/`, not `src/`.

## OVERVIEW
Host-absolute publish and ingest scripts. Success is one JSON line on stdout. Error tokens go to stderr; usage and refusal exit 2.

## WHERE TO LOOK
| Path | Role |
|------|------|
| `authority/publish-package-release.sh` | publish a given package; does not rebuild from a worktree |
| `authority/seal-release-manifest.mjs` | loads the manifest library from the trusted checkout `dist/` |
| `authority/publish-verified-release.sh` | always activates; requires the owner gate before `npm run build` |
| `control-center/publish-verified-release.sh` | same always-activate contract for the control-center root |
| `portfolio/` | collector writes a signed spool; ingest verifies; separate 0600 HMAC copies |
| `second-brain/provision-request-executor-keys.mjs` | Ed25519 keygen plus authority registration; requires `--apply` |
| `cleanup-test-artifacts.mjs` | `--apply` and exactly one of `--production` or `--fixture-root` |

## CONVENTIONS
- `JARVIS_STATE_ROOT` defaults to `/home/jm/.local/state/orca-jarvis`. Node default is the 24.19.0 absolute path.
- Release dirs are 40 hex under `releases/`. Activation is `ln` then `mv -Tf` of `current`.
- Package publish moves `current` only with `--activate` and `JARVIS_PRODUCTION_ACTIVATION_APPROVAL=approved`.
- Receipt JSON is `schema_version: 1`, sorted keys, compact separators, trailing newline. Release root mode 0700; payload 0644/0755.
- Digests use a domain string plus NUL. `node_modules` is hard-linked into the stage and omitted from the payload digest.

## ANTI-PATTERNS
- Do not derive the pinned receipt hash from the candidate. Do not import code from the candidate package when sealing.
- A release directory without its receipt is an interrupted publish, not a published release.
- `--unpublish` refuses a directory that has a receipt or that `current` points at.
- Do not let the portfolio collector open `jarvis.sqlite`, or let ingest spawn a collector.
- Do not point launchd or systemd `ExecStart` at the git worktree.
