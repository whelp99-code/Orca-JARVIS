#!/usr/bin/env node
import { spawn } from "node:child_process";
import { request } from "undici";
import { packageElectronApp } from "./lib/package-electron-app.mjs";
import { ElectronDeepLinkError, parseJarvisDeepLink } from "./lib/electron-deep-link.mjs";
import { ELECTRON_HEALTH_TIMEOUT_MS, ElectronClientError, parseElectronClientConfig, resolveElectronBinary } from "./lib/electron-shell.mjs";

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

try {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run product:open-electron -- [jarvis://open/today|recommendation-link]\n");
    process.exit(0);
  }
  const link = process.argv.slice(2).find(value => value.startsWith("jarvis:"));
  if (link !== undefined) parseJarvisDeepLink(link);
  const config = parseElectronClientConfig();
  try {
    const response = await request(`${config.authority_url}/api/v1/health`, {
      headersTimeout: ELECTRON_HEALTH_TIMEOUT_MS,
      bodyTimeout: ELECTRON_HEALTH_TIMEOUT_MS,
      maxRedirections: 0,
    });
    await response.body.dump();
    if (response.statusCode !== 200) throw new ElectronClientError("LINUX_AUTHORITY_UNAVAILABLE");
  } catch {
    throw new ElectronClientError("LINUX_AUTHORITY_UNAVAILABLE");
  }
  const home = process.env.JARVIS_PRODUCT_HOME;
  if (typeof home !== "string" || home.length === 0) throw new ElectronClientError("ELECTRON_PACKAGE_HOME_REQUIRED");
  resolveElectronBinary();
  const packaged = packageElectronApp(home, config);
  const child = spawn(packaged.executable, link === undefined ? [] : [link], { detached: true, stdio: "ignore" });
  child.unref();
  process.stdout.write(`${JSON.stringify({ ok: true, launched: true, pid: child.pid, package_path: packaged.packagePath, authority_url: config.authority_url })}\n`);
} catch (error) {
  fail(error instanceof ElectronClientError || error instanceof ElectronDeepLinkError ? error.code : "ELECTRON_OPEN_FAILED");
}
