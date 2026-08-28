import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { electronUnavailableHtml } from "./print-surfaces.mjs";
import { installedElectron } from "./electron-shell.mjs";

const MAIN = String.raw`const { app, BrowserWindow } = require("electron");
const config = require("./client-config.json");
let failed = false;
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const authority = new URL(config.authority_url);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== authority.origin) event.preventDefault();
  });
  win.webContents.on("did-fail-load", () => {
    if (failed) return;
    failed = true;
    void win.loadFile("unavailable.html");
  });
  void win.loadURL(config.authority_url);
});
app.on("window-all-closed", () => app.quit());
`;

function writeClientApp(appRoot, config) {
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "package.json"), `${JSON.stringify({ name: "jarvis-cli-jaw-client", version: "1.0.0", private: true, main: "main.cjs" }, null, 2)}\n`);
  writeFileSync(join(appRoot, "client-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(appRoot, "main.cjs"), MAIN);
  writeFileSync(join(appRoot, "unavailable.html"), electronUnavailableHtml("LINUX_AUTHORITY_UNAVAILABLE"));
}

export function packageElectronApp(home, config, platform = process.platform) {
  const { root } = installedElectron();
  const dist = join(root, "dist");
  const output = join(home, "electron-package");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  if (platform === "darwin") {
    const packagePath = join(output, "JARVIS.app");
    cpSync(join(dist, "Electron.app"), packagePath, { recursive: true, verbatimSymlinks: true });
    const resources = join(packagePath, "Contents", "Resources");
    rmSync(join(resources, "default_app.asar"), { force: true });
    writeClientApp(join(resources, "app"), config);
    return { packagePath, appResources: resources, executable: join(packagePath, "Contents", "MacOS", "Electron") };
  }
  cpSync(dist, output, { recursive: true, verbatimSymlinks: true });
  const resources = join(output, "resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  writeClientApp(join(resources, "app"), config);
  const executable = platform === "win32" ? join(output, "electron.exe") : join(output, "electron");
  return { packagePath: output, appResources: resources, executable };
}
