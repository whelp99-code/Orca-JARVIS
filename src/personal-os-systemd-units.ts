import { dirname } from "node:path";
import type { RenderMode, RenderRoots } from "./personal-os-systemd-roots.js";

function hardening(roots: RenderRoots): readonly string[] {
  return [
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    // A service account keeps its state outside every home directory, so /home can be made
    // invisible rather than merely read-only. That is the difference between a unit that happens
    // not to read the interactive user's files and one that cannot.
    roots.serviceUser === undefined ? "ProtectHome=read-only" : "ProtectHome=yes",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "SystemCallArchitectures=native",
  ];
}

function serviceBlock(roots: RenderRoots, lines: readonly string[]): string {
  const identity = roots.serviceUser === undefined
    ? []
    : [`User=${roots.serviceUser}`, `Group=${roots.serviceUser}`];
  return `${[...identity, ...lines, ...hardening(roots)].join("\n")}\n`;
}

function executablePath(roots: RenderRoots): string {
  return roots.serviceUser === undefined
    ? `${dirname(roots.nodeBin)}:${roots.binRoot}:/usr/bin:/bin`
    : `${dirname(roots.nodeBin)}:/usr/bin:/bin`;
}

/** The daily loop's flags, or nothing at all when the deployment configured no inputs for it. */
function dailyInputs(roots: RenderRoots): string {
  return roots.dailyServiceConfig === undefined || roots.dailyServiceKey === undefined ? ""
    : ` --input ${roots.dailyServiceConfig} --key-file ${roots.dailyServiceKey}`;
}

export function jarvisService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM JARVIS personal-OS authority (Linux)",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=simple",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `Environment=PATH=${executablePath(roots)}`,
      "Environment=NODE_ENV=production",
      `ExecStartPre=${roots.nodeBin} ${roots.authorityCurrent}/dist/src/cli.js db migrate --db ${roots.jarvisDb}`,
      `ExecStart=${roots.nodeBin} ${roots.authorityCurrent}/dist/src/cli.js service run --db ${roots.jarvisDb}`
        + dailyInputs(roots),
      "Restart=always",
      "RestartSec=5",
      `ReadWritePaths=${dirname(roots.jarvisDb)}`,
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "SystemCallFilter=@system-service",
    ]),
    "[Install]",
    `WantedBy=${roots.serviceUser === undefined ? "default.target" : "multi-user.target"}`,
    "",
  ].join("\n");
}

export function dashboardService(roots: RenderRoots): string {
  const main = `${roots.controlCenterCurrent}/dist/src/dashboard/main.js`;
  return [
    "[Unit]",
    "Description=JM Control Center dashboard (loopback 4173)",
    // The per-user installation waits for the Orca GUI session that owns the desktop it serves;
    // a system installation has no user session to wait for.
    roots.serviceUser === undefined ? "After=jm-jarvis.service orca-gui.service" : "After=jm-jarvis.service",
    "Wants=jm-jarvis.service",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=simple",
      `WorkingDirectory=${roots.controlCenterCurrent}`,
      `Environment=PATH=${executablePath(roots)}`,
      "Environment=NODE_ENV=production",
      `ExecStart=${roots.nodeBin} ${main} --host 127.0.0.1 --port 4173 --db ${roots.jarvisDb}`
        + ` --static-root ${roots.controlCenterCurrent}/dist/dashboard`,
      "Restart=always",
      "RestartSec=5",
      `ReadWritePaths=${dirname(roots.jarvisDb)}`,
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "SystemCallFilter=@system-service",
      "StandardOutput=journal",
      "StandardError=journal",
    ]),
    "[Install]",
    `WantedBy=${roots.serviceUser === undefined ? "default.target" : "multi-user.target"}`,
    "",
  ].join("\n");
}

export function backupService(roots: RenderRoots, mode: RenderMode): string {
  const executable = `${roots.nodeBin} ${roots.authorityCurrent}/dist/src/personal-os-backup-cli.js`;
  const argumentsText = `--db ${roots.jarvisDb} --backup-root ${roots.backupRoot}`;
  const productionFlag = mode === "production" ? " --production" : "";
  return [
    "[Unit]",
    "Description=JM JARVIS authority online backup",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=oneshot",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `ExecStart=${executable} ${argumentsText}${productionFlag}`,
      `ReadWritePaths=${dirname(roots.jarvisDb)}`,
    ]),
    "",
  ].join("\n");
}

export function backupTimer(): string {
  return [
    "[Unit]",
    "Description=JM JARVIS authority backup every 15 minutes",
    "",
    "[Timer]",
    "OnCalendar=*:0/15",
    "Persistent=true",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Unit=jm-jarvis-backup.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function providerBackupService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain lifecycle maintenance",
    "After=jm-second-brain-refresh.service",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=oneshot",
      `WorkingDirectory=${roots.providerCurrent}`,
      `Environment=SB_CONFIG=${roots.providerConfig}`,
      `ExecStart=${roots.providerCurrent}/bin/sb maintain --once`,
      `ReadWritePaths=${roots.providerState} ${roots.providerShare}`,
    ]),
    "",
  ].join("\n");
}

export function providerBackupTimer(): string {
  return [
    "[Unit]",
    "Description=JM Second Brain lifecycle maintenance after daily refresh",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 07:30:00 Asia/Seoul",
    "Persistent=true",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Unit=jm-second-brain-backup.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function requestsService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain apply-requests once",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=oneshot",
      `WorkingDirectory=${roots.providerCurrent}`,
      `Environment=SB_CONFIG=${roots.providerConfig}`,
      `ExecStart=${roots.providerCurrent}/bin/sb apply-requests --once`,
      `ReadWritePaths=${roots.providerState}`,
    ]),
    "",
  ].join("\n");
}

export function requestsPath(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain pending request path",
    `ConditionPathExists=${roots.providerMarker}`,
    "",
    "[Path]",
    `DirectoryNotEmpty=${roots.providerState}/requests/pending`,
    "Unit=jm-second-brain-requests.service",
    "",
    "[Install]",
    "WantedBy=paths.target",
    "",
  ].join("\n");
}
