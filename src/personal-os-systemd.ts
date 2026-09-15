export {
  type RenderMode,
  type RenderRoots,
  isolatedRenderRoots,
  productionRoots,
} from "./personal-os-systemd-roots.js";
import type { RenderMode, RenderRoots } from "./personal-os-systemd-roots.js";
import {
  backupService,
  backupTimer,
  dashboardService,
  jarvisService,
  providerBackupService,
  providerBackupTimer,
  requestsPath,
  requestsService,
} from "./personal-os-systemd-units.js";

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

export type GeneratedUnitId =
  | "jm-jarvis.service"
  | "jm-jarvis-dashboard.service"
  | "jm-jarvis-backup.service"
  | "jm-jarvis-backup.timer"
  | "jm-second-brain-backup.service"
  | "jm-second-brain-backup.timer"
  | "jm-second-brain-requests.service"
  | "jm-second-brain-requests.path";

export function renderSystemdUnit(input: {
  readonly id: GeneratedUnitId;
  readonly mode: RenderMode;
  readonly roots: RenderRoots;
}): string {
  switch (input.id) {
    case "jm-jarvis.service":
      return jarvisService(input.roots);
    case "jm-jarvis-dashboard.service":
      return dashboardService(input.roots);
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
