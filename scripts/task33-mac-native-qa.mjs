#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

const HELP = "TASK33_MAC_NATIVE_QA_HELP package+authority must target an isolated Linux authority\n";
if (process.argv.includes("--help")) { process.stdout.write(HELP); process.exit(0); }
if (process.platform !== "darwin") { process.stderr.write("TASK33_MAC_NATIVE_BLOCKED_PLATFORM\n"); process.exit(2); }
const packagePath = process.env.JARVIS_MAC_QA_PACKAGE;
const authorityValue = process.env.JARVIS_MAC_QA_AUTHORITY_URL;
const deepLink = process.env.JARVIS_MAC_QA_DEEP_LINK;
if (!packagePath || !authorityValue || !deepLink) { process.stderr.write("TASK33_MAC_NATIVE_QA_INPUT_REQUIRED\n"); process.exit(2); }
let authority;
try { authority = new URL(authorityValue); }
catch (error) { if (error instanceof TypeError) { process.stderr.write("TASK33_MAC_NATIVE_QA_INPUT_INVALID\n"); process.exit(2); } throw error; }
if (!/^https?:$/u.test(authority.protocol) || authority.username || authority.password || authority.pathname !== "/"
  || authority.search || authority.hash || !deepLink.startsWith("jarvis://open/")) {
  process.stderr.write("TASK33_MAC_NATIVE_QA_INPUT_INVALID\n"); process.exit(2);
}
const executable = join(packagePath, "Contents", "MacOS", "Electron");
try { accessSync(executable, constants.X_OK); }
catch (error) { if (error instanceof Error) { process.stderr.write("TASK33_MAC_NATIVE_QA_PACKAGE_INVALID\n"); process.exit(2); } throw error; }
const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
  JARVIS_AUTHORITY_URL: authority.origin } });
let output = "";
const occurrences = value => output.split(value).length - 1;
const marker = (expected, occurrence = 1) => new Promise((resolve, reject) => {
  const signal = AbortSignal.timeout(30_000);
  const cleanup = () => { child.stdout.off("data", read); child.off("exit", exited); };
  const found = () => { if (occurrences(expected) >= occurrence) { cleanup(); resolve(undefined); } };
  const read = chunk => { output += chunk.toString("utf8"); found(); };
  const exited = code => { cleanup(); reject(new TypeError(`TASK33_MAC_NATIVE_QA_EXIT_${code}`)); };
  child.stdout.on("data", read); child.once("exit", exited);
  signal.addEventListener("abort", () => { cleanup(); reject(new TypeError("TASK33_MAC_NATIVE_QA_TIMEOUT")); }, { once: true });
  found();
});
const run = async (command, args) => {
  const process = execFile(command, args); const [code] = await once(process, "exit");
  if (code !== 0) throw new TypeError("TASK33_MAC_NATIVE_QA_AUTOMATION_BLOCKED");
};
const clickScript = "tell application \"System Events\"\n tell process \"NotificationCenter\"\n"
  + "  click first UI element of first group of first scroll area of first window\n end tell\nend tell";
try {
  await marker("TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=2 shows=1 settles=1");
  const clicked = marker("TASK33_NATIVE_NOTIFICATION_CLICK");
  await run("/usr/bin/osascript", ["-e", clickScript]); await clicked;
  const firstOpen = marker("TASK33_DEEP_LINK_OPENED route=recommendation"); await firstOpen;
  const existingOpen = marker("TASK33_DEEP_LINK_OPENED route=recommendation", 2);
  await run("/usr/bin/open", [deepLink]); await existingOpen;
  process.stdout.write("TASK33_MAC_NATIVE_PASS shows=1 clicks=1 open_url=1 existing_instance=1 mac_authority=0\n");
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
}
