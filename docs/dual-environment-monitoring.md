# Dual-environment Orca monitoring (local + jm-server)

## Scope

JARVIS Master observes two Orca runtimes:

| Name | Selector | Role |
|------|----------|------|
| Local Mac | `local` (default Orca host) | DevSpace / Playground work |
| Acloud | `jm-server` | Tailscale remote (`ws://100.87.81.57:6769/`) |

Environment list (default):

```bash
export ORCA_JARVIS_ENVIRONMENTS=local,jm-server
```

## Master briefing routine

On session start / `관제탑 시작`, after reading `ORCA_MASTER_CHARTER.md` and `CONTROL_TOWER.md`, run **both** hosts:

```bash
# Local
orca status --json
orca terminal list --json
orca worktree ps --json
orca orchestration task-list --json 2>/dev/null || true

# Remote (jm-acloud / jm-server)
orca status --environment jm-server --json
orca terminal list --environment jm-server --json
orca worktree ps --environment jm-server --json
```

Briefing sections must split **LOCAL** and **JM-SERVER** (or merge with explicit host labels). Never imply remote facts from local-only output.

## Live supervisor path encoding

Remote worktrees are not mounted on the Mac. They are registered as:

```
/orca-env/<environment><absolute-remote-path>
```

Example:

```
/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner
```

When calling Orca, JARVIS decodes that to:

- `--environment jm-server`
- `--worktree path:/home/jm/orca/projects/jm-loop-miner`

## CLI

```bash
# Discover bindings on local + jm-server (default envs)
node dist/src/cli.js project discover --db .jarvis-runtime/jarvis.sqlite

# Override environments
node dist/src/cli.js project discover --environments local,jm-server --db .jarvis-runtime/jarvis.sqlite

# 10s service cycle uses the same multi-env observe path for registered bindings
node dist/src/cli.js service run --db .jarvis-runtime/jarvis.sqlite --interval-ms 10000
```

Worktree cap is **10** (was 5) so both hosts can register.

## Failure policy

- Local discovery failure is fatal for that cycle when only local is requested.
- Remote (`jm-server`) discovery failure is **tolerated** during multi-env discover so a Tailscale blip does not stop local supervision.
- Individual observe failures still surface as `unknown` progress for that binding.

## Operator checks

```bash
orca environment list --json
# expect name: jm-server, endpoint ws://100.87.81.57:6769/

node dist/src/cli.js report status --db .jarvis-runtime/jarvis.sqlite
node dist/src/cli.js project list --db .jarvis-runtime/jarvis.sqlite
```
