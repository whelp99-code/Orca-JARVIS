#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.env.JARVIS_SHELL_INSTALL_DIR ?? join(homedir(), ".local", "lib", "jarvis");
const sourceRoot = new URL("./", import.meta.url);
await mkdir(root, { recursive: true, mode: 0o700 });
await writeFile(join(root, "collect-terminal-evidence.mjs"), await readFile(new URL("./collect-terminal-evidence.mjs", sourceRoot)), { mode: 0o700 });
await writeFile(join(root, "jarvis-shell-fallback.zsh"), await readFile(new URL("./hooks/jarvis-shell-fallback.zsh", sourceRoot)), { mode: 0o600 });
await writeFile(join(root, "jarvis-shell-fallback.bash"), await readFile(new URL("./hooks/jarvis-shell-fallback.bash", sourceRoot)), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: true, installed: root, enabled: false, action: "source a template and set JARVIS_SHELL_FALLBACK_ENABLE=1 explicitly" })}\n`);
