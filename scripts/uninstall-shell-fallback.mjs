#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.env.JARVIS_SHELL_INSTALL_DIR ?? join(homedir(), ".local", "lib", "jarvis");
for (const name of ["collect-terminal-evidence.mjs", "jarvis-shell-fallback.zsh", "jarvis-shell-fallback.bash"]) await rm(join(root, name), { force: true });
process.stdout.write(`${JSON.stringify({ ok: true, uninstalled: root, enabled: false })}\n`);
