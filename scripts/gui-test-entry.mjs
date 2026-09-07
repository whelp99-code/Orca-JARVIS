#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let displayServer;
const env = { ...process.env };
try {
  if (process.platform === "linux") {
    if (!env.DISPLAY?.trim()) {
      const authority = join(env.TMPDIR, "Xauthority");
      const cookie = randomBytes(16).toString("hex");
      writeFileSync(authority, "", { mode: 0o600 });
      const authorize = display => execFileSync("xauth", ["-f", authority, "add", display, ".", cookie],
        { timeout: 3000, stdio: "ignore" });
      authorize(":0");
      displayServer = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1440x1000x24", "-nolisten", "tcp", "-auth", authority],
        { stdio: ["ignore", "ignore", "inherit", "pipe"] });
      const display = await new Promise((resolveDisplay, reject) => {
        let buffered = "";
        displayServer.once("error", reject);
        displayServer.once("exit", () => reject(new Error("TEST_DISPLAY_START_FAILED")));
        displayServer.stdio[3].on("data", chunk => {
          buffered += chunk;
          if (/^\d+\n$/.test(buffered)) resolveDisplay(`:${buffered.trim()}`);
          else if (buffered.length > 16 || buffered.includes("\n")) reject(new Error("TEST_DISPLAY_INVALID"));
        });
      });
      authorize(display); env.DISPLAY = display; env.XAUTHORITY = authority;
    }
    execFileSync("xdpyinfo", [], { env, timeout: 3000, stdio: "ignore" });
  }
  process.stdout.write("JARVIS_GUI_DISPLAY_READY\n");
  const child = spawn(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", ...process.argv.slice(2)],
    { env, stdio: "inherit" });
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject); child.once("exit", code => resolveExit(code ?? 1));
  });
} catch {
  process.stderr.write("TEST_DISPLAY_UNAVAILABLE\n"); process.exitCode = 2;
} finally {
  if (displayServer && displayServer.exitCode === null && displayServer.signalCode === null) {
    const closed = new Promise(resolveClose => displayServer.once("close", resolveClose));
    displayServer.kill("SIGTERM");
    const timer = setTimeout(() => displayServer.kill("SIGKILL"), 1000);
    await closed; clearTimeout(timer);
  }
}
