> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# scripts/ — Node ESM build / test / package drivers

Score 10 (50 files, 90% code; `scripts/lib` is the only importable layer). `src/` does not import this tree.

## OVERVIEW
`.mjs` CLIs plus `lib/` helpers; not in `tsconfig.json` or eslint paths; hand-written `lib/*.d.mts` beside some modules.

## WHERE TO LOOK
| Task | File |
|------|------|
| Test dispatcher | `run-tests.mjs` |
| Backend build | `build-backend.mjs` |
| Copy SQL+contracts+policy | `copy-migrations.mjs` |
| Runtime pin | `assert-runtime.mjs` |
| Import-cycle check | `check-runtime-imports.mjs` |
| Package / verify | `package-authority-runtime.mjs`, `verify-runtime-package.mjs` |
| Production-chain probe | `packaged-production-chain-probe.mjs` |
| Electron | `package-electron.mjs`, `open-electron.mjs`, `lib/electron-*.mjs` |
| Contract sync (v1 only) | `sync-second-brain-contract.mjs` |
| Build identity | `lib/backend-build-identity.mjs` |
| Test scratch | `lib/test-environment.mjs`, `lib/test-process.mjs` |

## CONVENTIONS
- Profiles: `backend|unit|integration|dashboard|gui|e2e|acceptance|smoke`. Filter-less backend runs Vitest `--shard=1/2` then `2/2`. Dashboard splices `--config dashboard/vite.config.ts --no-file-parallelism`.
- `createTestEnvironment`: mode 0700, default `~/.cache/orca-jarvis/tests`; invalid `TMPDIR` is not remapped. GUI on Linux without `DISPLAY` prefixes `bwrap`.
- Build: exclusive SQLite lock in `dist`; compile in staging; copy migrations/contracts; replace `BACKEND_OUTPUT_ROOTS` (`src,tests,migrations,contracts`); write `dist/build-metadata.json` last. Concurrent → `BACKEND_BUILD_ACTIVE`. `source_dirty=true` is not a deployable SHA.
- `copy-migrations.mjs` also copies `config/personal-os-policy.json` and an allow-list of 22 contract files (not `cancellation-result-v1.json`).
- Race workers import package name `orca-jarvis-shadow`, not relative `dist/`.
- Node 24.19.0 / ABI 137 (`assert-runtime.mjs` exit 64).

## ANTI-PATTERNS
- Do not `tsc` in-place over a running production `dist`.
- Manifest-less dist is not a successful build.
- `verify-runtime-package.mjs` must not import/execute candidate package code; pin receipt SHA256 before verify; never regenerate the expected hash from the candidate.
- `package-authority-runtime.mjs`: mkdtemp never reuses an existing output dir or moves a release pointer.
- `backend-build-identity.mjs`: only paths and digests leave; input contents never written to the manifest.
- Type-only / dynamic / external imports are out of `architecture:check` scope.
