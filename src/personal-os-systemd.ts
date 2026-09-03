import { dirname } from "node:path";

export const NODE_BIN = "/home/jm/.nvm/versions/node/v24.19.0/bin/node" as const;

export const UNIT_INVENTORY = {
  jarvis: [
    "jm-jarvis.service",
    "jm-jarvis-dashboard.service",
    "jm-jarvis-phone-gateway.service",
    "jm-jarvis-backup.service",
    "jm-jarvis-backup.timer",
    "jm-jarvis-portfolio-collector.service",
    "jm-jarvis-portfolio-collector.timer",
  ],
  provider: [
    "jm-second-brain-refresh.service",
    "jm-second-brain-refresh.timer",
    "jm-second-brain-requests.service",
    "jm-second-brain-requests.path",
    "jm-second-brain-backup.service",
    "jm-second-brain-backup.timer",
  ],
} as const;

export type RenderMode = "production" | "fixture";

export type RenderRoots = {
  readonly authorityCurrent: string;
  readonly jarvisDb: string;
  readonly backupRoot: string;
  readonly providerCurrent: string;
  readonly providerState: string;
};

export const PRODUCTION_ROOTS: RenderRoots = {
  authorityCurrent: "/home/jm/.local/state/orca-jarvis/authority/current",
  jarvisDb: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
  backupRoot: "/home/jm/.local/state/orca-jarvis/backups",
  providerCurrent: "/home/jm/.local/state/second-brain/app/current",
  providerState: "/home/jm/.local/state/second-brain",
};

export type GeneratedUnitId =
  | "jm-jarvis.service"
  | "jm-jarvis-backup.service"
  | "jm-jarvis-backup.timer"
  | "jm-second-brain-backup.service"
  | "jm-second-brain-backup.timer"
  | "jm-second-brain-requests.service"
  | "jm-second-brain-requests.path";

const HARDENING = [
  "UMask=0077",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "ProtectSystem=strict",
  "ProtectHome=read-only",
  "RestrictSUIDSGID=true",
  "LockPersonality=true",
  "SystemCallArchitectures=native",
] as const;

function serviceBlock(lines: readonly string[]): string {
  return `${[...lines, ...HARDENING].join("\n")}\n`;
}

function jarvisService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM JARVIS personal-OS authority (Linux)",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    serviceBlock([
      "Type=simple",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `Environment=PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:/home/jm/.local/bin:/usr/bin:/bin`,
      "Environment=NODE_ENV=production",
      `ExecStartPre=${NODE_BIN} ${roots.authorityCurrent}/dist/src/cli.js db migrate --db ${roots.jarvisDb}`,
      `ExecStart=${NODE_BIN} ${roots.authorityCurrent}/dist/src/cli.js service run --db ${roots.jarvisDb}`,
      "Restart=always",
      "RestartSec=5",
      `ReadWritePaths=${dirname(roots.jarvisDb)}`,
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "SystemCallFilter=@system-service",
    ]),
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function backupService(roots: RenderRoots, mode: RenderMode): string {
  const executable = `${NODE_BIN} ${roots.authorityCurrent}/dist/src/personal-os-backup-cli.js`;
  const argumentsText = `--db ${roots.jarvisDb} --backup-root ${roots.backupRoot}`;
  const productionFlag = mode === "production" ? " --production" : "";
  return [
    "[Unit]",
    "Description=JM JARVIS authority online backup",
    "",
    "[Service]",
    serviceBlock([
      "Type=oneshot",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `ExecStart=${executable} ${argumentsText}${productionFlag}`,
      `ReadWritePaths=${dirname(roots.jarvisDb)}`,
    ]),
    "",
  ].join("\n");
}

function backupTimer(): string {
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

function providerBackupService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain sealed-generation backup",
    "After=jm-second-brain-refresh.service",
    "",
    "[Service]",
    serviceBlock([
      "Type=oneshot",
      `WorkingDirectory=${roots.providerCurrent}`,
      `ExecStart=${roots.providerCurrent}/bin/sb backup --once --state ${roots.providerState}`,
      `ReadWritePaths=${roots.providerState}`,
    ]),
    "",
  ].join("\n");
}

function providerBackupTimer(): string {
  return [
    "[Unit]",
    "Description=JM Second Brain backup after daily refresh",
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

function requestsConfig(mode: RenderMode, roots: RenderRoots): string {
  return mode === "production"
    ? "/home/jm/.config/second-brain/config.toml"
    : `${roots.providerState}/config.toml`;
}

function requestsMarker(mode: RenderMode, roots: RenderRoots): string {
  return mode === "production"
    ? "/home/jm/.config/second-brain/request-executor.enabled"
    : `${roots.providerState}/request-executor.enabled`;
}

function requestsService(roots: RenderRoots, mode: RenderMode): string {
  return [
    "[Unit]",
    "Description=JM Second Brain apply-requests once",
    "",
    "[Service]",
    serviceBlock([
      "Type=oneshot",
      `WorkingDirectory=${roots.providerCurrent}`,
      `Environment=SB_CONFIG=${requestsConfig(mode, roots)}`,
      `ExecStart=${roots.providerCurrent}/bin/sb apply-requests --once`,
      `ReadWritePaths=${roots.providerState}`,
    ]),
    "",
  ].join("\n");
}

function requestsPath(roots: RenderRoots, mode: RenderMode): string {
  return [
    "[Unit]",
    "Description=JM Second Brain pending request path",
    `ConditionPathExists=${requestsMarker(mode, roots)}`,
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

export function renderSystemdUnit(input: {
  readonly id: GeneratedUnitId;
  readonly mode: RenderMode;
  readonly roots: RenderRoots;
}): string {
  switch (input.id) {
    case "jm-jarvis.service":
      return jarvisService(input.roots);
    case "jm-jarvis-backup.service":
      return backupService(input.roots, input.mode);
    case "jm-jarvis-backup.timer":
      return backupTimer();
    case "jm-second-brain-backup.service":
      return providerBackupService(input.roots);
    case "jm-second-brain-backup.timer":
      return providerBackupTimer();
    case "jm-second-brain-requests.service":
      return requestsService(input.roots, input.mode);
    case "jm-second-brain-requests.path":
      return requestsPath(input.roots, input.mode);
    default: {
      const unreachable: never = input.id;
      return unreachable;
    }
  }
}
