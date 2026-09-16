import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEPLOYMENT_ROOT_VARIABLES,
  SERVICE_USER_VARIABLE,
  resolveDeploymentRoots,
} from "./personal-os-deployment-roots.js";
import { JarvisError } from "./jarvis-error.js";
import {
  type GeneratedUnitId,
  RENDERED_UNITS_README_ID,
  TASK_EXECUTOR_DROPIN_ID,
  productionRoots,
  renderSystemdUnit,
  renderedUnitsReadme,
} from "./personal-os-systemd.js";

/** The units this command can render. The rest of the inventory is installed, not generated. */
const RENDERABLE: readonly GeneratedUnitId[] = [
  "jm-jarvis.service",
  TASK_EXECUTOR_DROPIN_ID,
  "jm-jarvis-dashboard.service",
  "jm-jarvis-phone-gateway.service",
  "jm-jarvis-portfolio-collector.service",
  "jm-jarvis-portfolio-collector.timer",
  "jm-jarvis-portfolio-ingest.service",
  "jm-jarvis-portfolio-ingest.timer",
  "jm-jarvis-backup.service",
  "jm-jarvis-backup.timer",
  "jm-second-brain-backup.service",
  "jm-second-brain-backup.timer",
  "jm-second-brain-requests.service",
  "jm-second-brain-requests.path",
];

/**
 * `deployment roots` and `deployment render-units` — the two things an operator needs before a
 * cutover: what this build believes every production path is, and the unit files that follow from
 * it. Both read only the environment, open no database, and write nothing outside `--out`.
 */
export function tryExecuteDeploymentCommand(input: {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}): Record<string, unknown> | undefined {
  const [command, subcommand] = input.positionals;
  if (command !== "deployment") return undefined;
  const out = input.values["out"];
  if (subcommand === "roots") {
    if (input.positionals.length !== 2 || out !== undefined) throw new JarvisError("CLI_ARGUMENT_INVALID");
    const roots = resolveDeploymentRoots();
    return {
      ok: true,
      command: "deployment.roots",
      variables: { ...DEPLOYMENT_ROOT_VARIABLES, serviceUser: SERVICE_USER_VARIABLE },
      roots,
      // The operator's acceptance question, answered by the build itself rather than by grep: is
      // there any configured path still inside the interactive user's home?
      home_paths: Object.entries(roots)
        .filter(([, value]) => typeof value === "string" && value.startsWith("/home/"))
        .map(([key]) => key),
    };
  }
  if (subcommand !== "render-units") return undefined;
  if (input.positionals.length !== 2 || typeof out !== "string" || !out.startsWith("/")) {
    throw new JarvisError("CLI_ARGUMENT_INVALID");
  }
  const roots = productionRoots();
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const units = RENDERABLE.map((id) => {
    const text = renderSystemdUnit({ id, mode: "production", roots });
    const path = join(out, id);
    // A drop-in is a file inside `<unit>.d/`, so the generator creates that directory too and the
    // output tree is the one an operator installs, not a flat list they have to rearrange.
    if (id.includes("/")) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o644 });
    return { id, path, bytes: Buffer.byteLength(text), names_home: text.includes("/home/") };
  });
  // The operator step the units cannot carry themselves - copying the versioned task executor into
  // the bin root, and re-pinning it on upgrade - is written beside them, from the same roots.
  const readme = renderedUnitsReadme({ roots, unitIds: RENDERABLE });
  const readmePath = join(out, RENDERED_UNITS_README_ID);
  writeFileSync(readmePath, readme, { mode: 0o644 });
  return {
    ok: true,
    command: "deployment.render-units",
    out,
    service_user: roots.serviceUser ?? null,
    task_claude_path: roots.taskClaudePath ?? null,
    readme: readmePath,
    units,
  };
}
