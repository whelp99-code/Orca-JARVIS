# Historical Mac LaunchAgent archive

Status: `HISTORICAL_NON_EXECUTABLE`.

These plists are not production supervisors. Do not `launchctl` bootstrap, bootout, or kickstart them. Do not install a Mac LaunchAgent from this tree.

They are retained only as a record of a retired Mac dashboard/sqlite path. Authority, scheduling, gateway, backup, and release live on Linux.

Linux authority:

- `docs/personal-os/release.md`
- `docs/personal-os/operations.md`
- `docs/personal-os/disaster-recovery.md`
- `deploy/jm-jarvis-dashboard.service`
- `deploy/jm-jarvis.service` (committed target topology `authority/current`; live ExecStart mutation is out of scope)

Mac remains client/package/native-QA only.
