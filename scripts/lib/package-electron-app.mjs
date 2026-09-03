import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronUnavailableHtml } from "./print-surfaces.mjs";
import { electronMainSource, task33ElectronMainSource } from "./electron-main-source.mjs";
import { ELECTRON_BUNDLE_ID, ELECTRON_PROTOCOL_SCHEME, installedElectron } from "./electron-shell.mjs";

const LIB = dirname(fileURLToPath(import.meta.url));
function writeClientApp(appRoot, config, mainSource) {
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "package.json"), `${JSON.stringify({
    name: "jarvis-cli-jaw-client", version: "1.0.0", private: true, main: "main.cjs",
  }, null, 2)}\n`);
  writeFileSync(join(appRoot, "client-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(appRoot, "main.cjs"), mainSource);
  cpSync(join(LIB, "electron-deep-link.mjs"), join(appRoot, "electron-deep-link.mjs"));
  cpSync(join(LIB, "electron-notification-client.mjs"), join(appRoot, "electron-notification-client.mjs"));
  writeFileSync(join(appRoot, "unavailable.html"), electronUnavailableHtml("LINUX_AUTHORITY_UNAVAILABLE"));
}
function configureMacBundle(packagePath) {
  const infoPath = join(packagePath, "Contents", "Info.plist");
  let info = readFileSync(infoPath, "utf8");
  info = info.replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]+<\/string>/u,
    `<key>CFBundleIdentifier</key>\n\t<string>${ELECTRON_BUNDLE_ID}</string>`);
  const protocol = `\n\t<key>CFBundleURLTypes</key>\n\t<array><dict>\n\t\t<key>CFBundleURLName</key>`
    + `\n\t\t<string>${ELECTRON_BUNDLE_ID}</string>\n\t\t<key>CFBundleURLSchemes</key>`
    + `\n\t\t<array><string>${ELECTRON_PROTOCOL_SCHEME}</string></array>\n\t</dict></array>\n`;
  const marker = info.lastIndexOf("</dict>");
  if (marker < 0) throw new TypeError("ELECTRON_PACKAGE_FAILED");
  writeFileSync(infoPath, `${info.slice(0, marker)}${protocol}${info.slice(marker)}`);
}
function packageElectronAppWithSource(home, config, platform, mainSource) {
  const { root } = installedElectron();
  const dist = join(root, "dist"); const output = join(home, "electron-package");
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  if (platform === "darwin") {
    const packagePath = join(output, "JARVIS.app");
    cpSync(join(dist, "Electron.app"), packagePath, { recursive: true, verbatimSymlinks: true });
    configureMacBundle(packagePath);
    const resources = join(packagePath, "Contents", "Resources");
    rmSync(join(resources, "default_app.asar"), { force: true }); writeClientApp(join(resources, "app"), config, mainSource);
    return { packagePath, appResources: resources, executable: join(packagePath, "Contents", "MacOS", "Electron") };
  }
  cpSync(dist, output, { recursive: true, verbatimSymlinks: true });
  const resources = join(output, "resources"); rmSync(join(resources, "default_app.asar"), { force: true });
  writeClientApp(join(resources, "app"), config, mainSource);
  const executable = platform === "win32" ? join(output, "electron.exe") : join(output, "electron");
  return { packagePath: output, appResources: resources, executable };
}

export function packageElectronApp(home, config, platform = process.platform) {
  return packageElectronAppWithSource(home, config, platform, electronMainSource());
}

export function packageTask33ElectronApp(home, config, platform = process.platform) {
  return packageElectronAppWithSource(home, config, platform, task33ElectronMainSource());
}
