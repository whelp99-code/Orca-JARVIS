import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedRenderRoots, renderSystemdUnit, type GeneratedUnitId } from "./personal-os-systemd.js";

const LIVE_UNIT = "/home/jm/.config/systemd/user/jm-jarvis.service";

export type RenderedUnits = {
  readonly dir: string;
  readonly ids: readonly string[];
  readonly jarvisExecStart: string;
  readonly pointsAtCurrent: boolean;
  readonly installed: false;
  readonly liveUnit: {
    readonly path: string;
    readonly present: boolean;
    readonly worktreeExec: boolean;
    readonly applied: false;
  };
};

function execStart(text: string): string {
  const line = text.split("\n").find(item => item.startsWith("ExecStart="));
  return line ?? "";
}

export function renderIsolatedUnits(input: {
  readonly releaseRoot: string;
  readonly dbPath: string;
  readonly providerCurrent: string;
}): RenderedUnits {
  const dir = join(input.releaseRoot, "units");
  mkdirSync(dir, { recursive: true });
  const roots = isolatedRenderRoots({
    root: join(input.releaseRoot, "state"),
    authorityCurrent: join(input.releaseRoot, "current"),
    jarvisDb: input.dbPath,
    providerCurrent: input.providerCurrent,
  });
  const ids: readonly GeneratedUnitId[] = [
    "jm-jarvis.service",
    "jm-jarvis-dashboard.service",
    "jm-jarvis-phone-gateway.service",
    "jm-jarvis-backup.service",
    "jm-jarvis-backup.timer",
    "jm-jarvis-portfolio-collector.service",
    "jm-jarvis-portfolio-collector.timer",
    "jm-jarvis-portfolio-ingest.service",
    "jm-jarvis-portfolio-ingest.timer",
    "jm-second-brain-backup.service",
    "jm-second-brain-backup.timer",
    "jm-second-brain-requests.service",
    "jm-second-brain-requests.path",
  ];
  for (const id of ids) {
    writeFileSync(join(dir, id), renderSystemdUnit({ id, mode: "fixture", roots }));
  }
  const jarvis = readFileSync(join(dir, "jm-jarvis.service"), "utf8");
  const phone = readFileSync(join(dir, "jm-jarvis-phone-gateway.service"), "utf8");
  const current = join(input.releaseRoot, "current");
  const live = existsSync(LIVE_UNIT) ? readFileSync(LIVE_UNIT, "utf8") : undefined;
  return {
    dir,
    ids,
    jarvisExecStart: execStart(jarvis),
    pointsAtCurrent: jarvis.includes(current) && phone.includes("127.0.0.1") && !jarvis.includes("/orca/workspaces/"),
    installed: false,
    liveUnit: {
      path: LIVE_UNIT,
      present: live !== undefined,
      worktreeExec: live !== undefined && live.includes("/orca/workspaces/"),
      applied: false,
    },
  };
}
