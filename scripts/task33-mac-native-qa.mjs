#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

const HELP = "TASK33_MAC_NATIVE_QA_HELP --expected-title <synthetic> --expected-body <synthetic>\n";
if (process.argv.includes("--help")) { process.stdout.write(HELP); process.exit(0); }
if (process.platform !== "darwin") { process.stderr.write("TASK33_MAC_NATIVE_BLOCKED_PLATFORM\n"); process.exit(2); }
function argument(name) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) return undefined;
  const value = process.argv[indexes[0] + 1]; return typeof value === "string" && !value.startsWith("--") ? value : undefined;
}
const packagePath = process.env.JARVIS_MAC_QA_PACKAGE;
const authorityValue = process.env.JARVIS_MAC_QA_AUTHORITY_URL;
const deepLink = process.env.JARVIS_MAC_QA_DEEP_LINK;
const expectedTitle = argument("--expected-title"); const expectedBody = argument("--expected-body");
const syntheticTitle = /^Task33 QA [A-Z0-9_-]{1,32}$/u; const syntheticBody = /^Synthetic decision [A-Z0-9_-]{1,32}$/u;
if (!packagePath || !authorityValue || !deepLink || !expectedTitle || !expectedBody) {
  process.stderr.write("TASK33_MAC_NATIVE_QA_INPUT_REQUIRED\n"); process.exit(2);
}
let authority;
try { authority = new URL(authorityValue); }
catch (error) { if (error instanceof TypeError) { process.stderr.write("TASK33_MAC_NATIVE_QA_INPUT_INVALID\n"); process.exit(2); } throw error; }
if (!/^https?:$/u.test(authority.protocol) || authority.username || authority.password || authority.pathname !== "/"
  || authority.search || authority.hash || !deepLink.startsWith("jarvis://open/")
  || !syntheticTitle.test(expectedTitle) || !syntheticBody.test(expectedBody)) {
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
const exactClick = async () => {
  const process = execFile("/usr/bin/osascript", ["-e", clickScript, expectedTitle, expectedBody]);
  let receipt = ""; process.stdout.on("data", chunk => { receipt += chunk.toString("utf8"); });
  const [code] = await once(process, "exit");
  if (code !== 0 || receipt.trim() !== "1") throw new TypeError("TASK33_MAC_NATIVE_QA_EXACT_MATCH_REQUIRED");
};
const clickScript = `on run argv
 set expectedTitle to item 1 of argv
 set expectedBody to item 2 of argv
 tell application "System Events"
  tell process "NotificationCenter"
   set matchCount to 0
   set matchedCandidate to missing value
   repeat with candidate in entire contents of windows
    try
     set visibleText to value of static texts of candidate
     if (count of visibleText) is 2 then
      set candidateTitle to item 1 of visibleText
      set candidateBody to item 2 of visibleText
      if candidateTitle is expectedTitle and candidateBody is expectedBody then
       set matchCount to matchCount + 1
       set matchedCandidate to candidate
      end if
     end if
    end try
   end repeat
   if matchCount is not 1 then error number 65
   click matchedCandidate
   return matchCount
  end tell
 end tell
end run`;
try {
  await marker("TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=2 shows=1 settles=1");
  const clicked = marker("TASK33_NATIVE_NOTIFICATION_CLICK");
  await exactClick(); await clicked;
  const firstOpen = marker("TASK33_DEEP_LINK_OPENED route=recommendation"); await firstOpen;
  const existingOpen = marker("TASK33_DEEP_LINK_OPENED route=recommendation", 2);
  await run("/usr/bin/open", [deepLink]); await existingOpen;
  process.stdout.write("TASK33_MAC_NATIVE_PASS shows=1 clicks=1 open_url=1 existing_instance=1 mac_authority=0\n");
} finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
}
