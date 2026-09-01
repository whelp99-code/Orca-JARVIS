# Mac Electron client packaging (docs only)

Mac is `mac-client-only`. It is not an authority, scheduler, gateway, backup, or release host.

Packaging commands live in `scripts/package-electron.mjs` and `scripts/open-electron.mjs`. They produce an unsigned client that talks to Linux loopback/tailnet authority.

Do not:

- run JARVIS or Second Brain production on macOS
- mint ControlPlane receipts on the client
- treat LaunchAgent/plist files as production supervisors
- sign, notarize, or ship to an app store from this plan

Native QA against Linux is a separate `device-observation-separate` lane.
