# Control Center release and LaunchAgent

Status: `HISTORICAL_NON_EXECUTABLE`.
This file is historical archive only. Do not run LaunchAgent, `launchctl`, `/Volumes/DevSpace`, or control-center activation from it.
Linux authority release procedures: `docs/personal-os/release.md` and `docs/personal-os/disaster-recovery.md`.

Retired Mac dashboard LaunchAgent definitions live under `docs/historical/mac-launchagents/` and are not executable. The Linux dashboard unit is `deploy/jm-jarvis-dashboard.service`.

Do not copy those plists into `~/Library/LaunchAgents`. Do not treat `/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite` as an AuthorityDb.

JM-SERVER historical control-center notes: [`jm-control-center-release.md`](./jm-control-center-release.md). That file is also `HISTORICAL_NON_EXECUTABLE`. Live `jm-jarvis.service` ExecStart mutation is out of scope; see `docs/personal-os/operations.md`.
