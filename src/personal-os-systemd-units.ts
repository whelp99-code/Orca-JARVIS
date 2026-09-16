import { dirname, resolve } from "node:path";
import type { RenderMode, RenderRoots } from "./personal-os-systemd-roots.js";

/**
 * The provider roots that are still inside a home directory. The cutover may leave the Second Brain
 * provider under the interactive user's home (its config carries eight absolute paths and one
 * source rooted in the user's own notes), and the authority spawns the provider's MCP child. When
 * that is the configuration, `ProtectHome=yes` would make the service unstartable, so the generator
 * says read-only and names the trees instead of leaving an operator to discover it in a drop-in.
 */
export function providerRootsUnderHome(roots: RenderRoots): readonly string[] {
  return [roots.providerState, roots.providerShare, roots.providerConfig]
    .filter(path => resolve(path).startsWith("/home/"));
}

/** The provider trees a unit must be able to write when the provider stayed under /home. */
function providerWritePaths(roots: RenderRoots): readonly string[] {
  return roots.serviceUser !== undefined && providerRootsUnderHome(roots).length > 0
    ? [`ReadWritePaths=${roots.providerState} ${roots.providerShare}`]
    : [];
}

function hardening(roots: RenderRoots): readonly string[] {
  return [
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    // A service account keeps its state outside every home directory, so /home can be made
    // invisible rather than merely read-only. That is the difference between a unit that happens
    // not to read the interactive user's files and one that cannot — and it holds only while no
    // configured provider root is still inside a home.
    roots.serviceUser === undefined || providerRootsUnderHome(roots).length > 0
      ? "ProtectHome=read-only" : "ProtectHome=yes",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "SystemCallArchitectures=native",
  ];
}

export function serviceBlock(roots: RenderRoots, lines: readonly string[]): string {
  const identity = roots.serviceUser === undefined
    ? []
    : [`User=${roots.serviceUser}`, `Group=${roots.serviceUser}`];
  return `${[...identity, ...lines, ...hardening(roots)].join("\n")}\n`;
}

export function executablePath(roots: RenderRoots): string {
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
      // The authority spawns the provider's MCP child, which writes into the provider's request
      // and share trees. Rendered, not hand-written, so it cannot disagree with ProtectHome above.
      ...providerWritePaths(roots),
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
