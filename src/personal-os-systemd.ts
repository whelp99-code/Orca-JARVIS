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

const REHEARSAL_DB = "/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite" as const;
const REHEARSAL_BACKUP_ROOT = "/home/jm/.local/state/jarvis-rehearsal/backups" as const;
const SECOND_BRAIN_CLI = "/home/jm/.local/bin/sb" as const;

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
      `ExecStart=${NODE_BIN} ${roots.authorityCurrent}/dist/src/cli.js service run --db ${roots.jarvisDb}`,
      "Restart=always",
      "RestartSec=5",
      `ReadWritePaths=${roots.authorityCurrent} ${roots.jarvisDb} ${roots.backupRoot}`,
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
  const db = mode === "production" ? REHEARSAL_DB : roots.jarvisDb;
  const backupRoot = mode === "production" ? REHEARSAL_BACKUP_ROOT : roots.backupRoot;
  return [
    "[Unit]",
    "Description=JM JARVIS authority online backup",
    "",
    "[Service]",
    serviceBlock([
      "Type=oneshot",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `ExecStart=${NODE_BIN} ${roots.authorityCurrent}/dist/src/personal-os-backup-cli.js --db ${db} --backup-root ${backupRoot}`,
      `ReadWritePaths=${backupRoot}`,
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
      `ExecStart=${SECOND_BRAIN_CLI} backup --once --state ${roots.providerState}`,
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

function requestsService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain apply-requests once",
    "",
    "[Service]",
    serviceBlock([
      "Type=oneshot",
      `WorkingDirectory=${roots.providerCurrent}`,
      `ExecStart=${SECOND_BRAIN_CLI} apply-requests --once`,
      `ReadWritePaths=${roots.providerState}`,
    ]),
    "",
  ].join("\n");
}

function requestsPath(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=JM Second Brain pending request path",
    "",
    "[Path]",
    `PathExists=${roots.providerState}/requests/pending`,
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
      return requestsService(input.roots);
    case "jm-second-brain-requests.path":
      return requestsPath(input.roots);
    default: {
      const unreachable: never = input.id;
      return unreachable;
    }
  }
}
