# Dual-environment Orca monitoring (Linux control plane + jm-server)

## Scope and authority

The default `local` Orca environment is the Linux control plane. It is identified as `linux-control-plane` and is the only local/default JARVIS authority runtime.

| Environment | Identity | Role |
|---|---|---|
| `local` | `linux-control-plane` | Default authority and local Orca observation |
| `jm-server` | `jm-server` | Explicit remote Orca observation over Tailscale |
| optional QA client | `mac-client` | Client-only evidence; never authority or a master runtime |

The normal monitoring set is explicit:

```bash
export ORCA_JARVIS_ENVIRONMENTS=local,jm-server
```

A Mac may submit bounded QA evidence under the distinct `mac-client` identity. It does not replace `local`, run the authority database, or establish completion from terminal output.

## Control-plane briefing routine

On Linux session start, after reading `ORCA_MASTER_CHARTER.md` and `CONTROL_TOWER.md`, inspect both configured environments. The unqualified commands target the local Linux authority:

```bash
# Linux control plane (local/default)
orca status --json
orca terminal list --json
orca worktree ps --json
orca orchestration task-list --json 2>/dev/null || true

# Explicit remote observation
orca status --environment jm-server --json
orca terminal list --environment jm-server --json
orca worktree ps --environment jm-server --json
```

Briefings must label facts `LINUX-CONTROL-PLANE` or `JM-SERVER`. Never infer remote facts from local output, and never infer task completion from terminal preview, prose, idle state, or prompt return.

## Remote worktree path encoding

Remote worktrees are not local mounts. JARVIS stores them as:

```text
/orca-env/<environment><absolute-remote-path>
```

For example:

```text
/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner
```

The Linux adapter decodes that identity into the explicit `jm-server` environment and the remote absolute worktree selector. Host, environment, worktree, terminal, incarnation, and cursor identities remain separate in normalized observations.

## Linux CLI operations

Run the built CLI from the Linux control-plane checkout:

```bash
# Discover local Linux and jm-server bindings.
node dist/src/cli.js project discover --db .jarvis-runtime/jarvis.sqlite

# Override the environment set explicitly.
node dist/src/cli.js project discover --environments local,jm-server --db .jarvis-runtime/jarvis.sqlite

# Observe registered bindings on the same multi-environment path.
node dist/src/cli.js service run --db .jarvis-runtime/jarvis.sqlite --interval-ms 10000
```

The worktree cap is 10 so both observed environments can register without conflating their identities.

## Failure and evidence policy

- A local/default failure is a Linux control-plane failure and is fatal when only `local` is requested.
- A `jm-server` discovery failure may be tolerated in multi-environment discovery so a remote network interruption does not stop local supervision.
- Individual observation failures remain explicit unknown/unavailable states.
- Authenticated portfolio reports and structured TaskTimeline decision/evidence references are accepted; raw terminal text and secret-bearing fields are not.
- Exact replay is idempotent. Stale incarnation, ambiguous terminal identity, out-of-order portfolio state, and cross-host collisions fail closed.
- Optional `mac-client` QA evidence stays client evidence and cannot confer authority.

## Operator checks

These checks run on the Linux control plane:

```bash
orca environment list --json
# Expected saved remote: jm-server.

node dist/src/cli.js report status --db .jarvis-runtime/jarvis.sqlite
node dist/src/cli.js project list --db .jarvis-runtime/jarvis.sqlite
```

## Historical, non-executable guidance

Earlier revisions called `local` a "Local Mac", described JARVIS as a Mac master, and instructed operators to run master-runtime commands from that Mac. Those instructions are retired historical context only. They must not be copied into a shell, run as an operating procedure, or used to select authority. Current executable instructions appear only in the Linux sections above; Mac participation is limited to optional `mac-client` QA evidence.
