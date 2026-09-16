import type { RenderRoots } from "./personal-os-systemd-roots.js";

/**
 * The generated drop-in that names the task executor, and the operator note that has to travel with
 * it. The executor is the one deployment path a cutover cannot simply copy: it ships as a single
 * versioned file under the interactive user's `~/.local/share/claude/versions/<version>`, that home
 * is 0750, and a `nologin` service account cannot traverse it. Widening an ACL over the user's
 * `.local/share` would trade the whole point of the migration for one binary, so the deployment
 * names the executor under its own bin root and the operator puts a copy there.
 */
export const TASK_EXECUTOR_DROPIN_ID = "jm-jarvis.service.d/20-task-executor.conf" as const;
export const RENDERED_UNITS_README_ID = "README.md" as const;

export function taskExecutorDropIn(roots: RenderRoots): string {
  if (roots.taskClaudePath === undefined) {
    // Nothing configured and no account to default for: an empty [Service] section would still
    // install, so say why the drop-in is inert instead of naming a path this build did not resolve.
    return [
      "[Service]",
      "# No task executor is configured for this deployment (JARVIS_TASK_CLAUDE_PATH unset and no",
      "# JARVIS_SERVICE_USER to default a bin-root path for), so this drop-in sets nothing.",
      "",
    ].join("\n");
  }
  return [
    "[Service]",
    "# The task executor is reached through the deployment's bin root, never through the",
    "# interactive user's home: that home is 0750 and a nologin service account cannot traverse",
    "# it. Copy the versioned executor into the bin root and re-pin it on every upgrade - see",
    `# ${RENDERED_UNITS_README_ID} beside this file for the exact command.`,
    `Environment=JARVIS_TASK_CLAUDE_PATH=${roots.taskClaudePath}`,
    "",
  ].join("\n");
}

/** The operator runbook section the generator emits beside the units it just wrote. */
export function renderedUnitsReadme(input: {
  readonly roots: RenderRoots;
  readonly unitIds: readonly string[];
}): string {
  const { roots } = input;
  const executor = roots.taskClaudePath;
  return [
    "# Rendered systemd units",
    "",
    "Written by `deployment render-units` from this build's configured deployment roots, which",
    "`deployment roots` prints. Every path below came from the environment, so these files cannot",
    "disagree with what the service resolves at runtime. Review them, then install them.",
    "",
    `- Service account: ${roots.serviceUser ?? "(none - per-user installation)"}`,
    `- Authority release: ${roots.authorityCurrent}`,
    `- Authority database: ${roots.jarvisDb}`,
    `- Task executor: ${executor ?? "(not configured)"}`,
    "",
    ...input.unitIds.map(id => `- ${id}`),
    "",
    "## Task executor: copy the versioned binary into the bin root, and re-pin on upgrade",
    "",
    "The Claude task executor ships as one versioned file under the interactive user's",
    "`~/.local/share/claude/versions/<version>`. That home is 0750, so a `nologin` service account",
    "cannot traverse it, and no ACL should be granted over it for this - the point of the service",
    "account is that it reads nothing in the user's home. Install a copy into the bin root instead:",
    "",
    "```bash",
    `sudo install -m 0755 -o ${roots.serviceUser ?? "root"} -g ${roots.serviceUser ?? "root"} \\`,
    `  ~/.local/share/claude/versions/<version> ${executor ?? "<JARVIS_BIN_ROOT>/claude"}`,
    `sudo -u ${roots.serviceUser ?? "root"} test -x ${executor ?? "<JARVIS_BIN_ROOT>/claude"} && echo executable`,
    "```",
    "",
    "The loader refuses an executable that is group- or other-writable and demands a plain file, so",
    "0755 owned by the service account is the loosest mode that resolves. **Repeat the copy on every",
    "executor upgrade**: this path is stable, the binary behind it is not, and nothing re-pins it.",
    "Confirm after each copy, as the service account:",
    "",
    "```bash",
    `${roots.nodeBin} ${roots.authorityCurrent}/dist/src/cli.js routing probe-runtime claude-code`,
    "```",
    "",
    "Until that copy exists the executor reports `TASK_PROVIDER_UNAVAILABLE` and task execution is",
    "simply unavailable; nothing else in the authority degrades.",
    "",
  ].join("\n");
}
