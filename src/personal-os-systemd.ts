export {
  type RenderMode,
  type RenderRoots,
  isolatedRenderRoots,
  productionRoots,
} from "./personal-os-systemd-roots.js";
import type { RenderMode, RenderRoots } from "./personal-os-systemd-roots.js";
import { TASK_EXECUTOR_DROPIN_ID, taskExecutorDropIn } from "./personal-os-systemd-dropins.js";
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

export {
  RENDERED_UNITS_README_ID,
  TASK_EXECUTOR_DROPIN_ID,
  renderedUnitsReadme,
} from "./personal-os-systemd-dropins.js";

/**
 * Every artifact the generator can write. The drop-in is a generated file like the units are: the
 * executor path it carries follows the deployment roots, so it cannot be left hand-written.
 */
export type GeneratedUnitId =
  | typeof TASK_EXECUTOR_DROPIN_ID
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
    case TASK_EXECUTOR_DROPIN_ID:
      return taskExecutorDropIn(input.roots);
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
