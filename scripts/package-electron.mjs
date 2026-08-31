#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { packageElectronApp } from "./lib/package-electron-app.mjs";
import { describeElectronShell, ELECTRON_BUNDLE_ID, ElectronClientError, ELECTRON_PROTOCOL_SCHEME, ELECTRON_VERSION,
  parseElectronClientConfig, resolveElectronBinary } from "./lib/electron-shell.mjs";

function fail(error) {
  const code = error instanceof ElectronClientError ? error.code : "ELECTRON_PACKAGE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

try {
  if (process.env.ELECTRON_DESCRIBE === "1") {
    process.stdout.write(`${JSON.stringify(describeElectronShell())}\n`);
    process.exit(0);
  }
  const home = process.env.JARVIS_PRODUCT_HOME;
  if (typeof home !== "string" || home.length === 0) throw new ElectronClientError("ELECTRON_PACKAGE_HOME_REQUIRED");
  const config = parseElectronClientConfig();
  const electronBinary = resolveElectronBinary();
  const version = spawnSync(electronBinary, ["--no-sandbox", "--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.status !== 0 || version.stdout.trim() !== `v${ELECTRON_VERSION}`) {
    throw new ElectronClientError("ELECTRON_VERSION_MISMATCH");
  }
  mkdirSync(home, { recursive: true });
  const packaged = packageElectronApp(home, config);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "package-electron",
    electron_version: ELECTRON_VERSION,
    electron_binary: electronBinary,
    package_path: packaged.packagePath,
    app_resources: packaged.appResources,
    executable: packaged.executable,
    authority_url: config.authority_url,
    authority_mode: config.authority_mode,
    bundle_id: ELECTRON_BUNDLE_ID,
    protocol_scheme: ELECTRON_PROTOCOL_SCHEME,
  })}\n`);
} catch (error) {
  fail(error);
}
