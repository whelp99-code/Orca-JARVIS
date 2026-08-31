import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const ELECTRON_VERSION = "44.0.0";
export const ELECTRON_BUNDLE_ID = "com.jmpark.orca-jarvis";
export const ELECTRON_PROTOCOL_SCHEME = "jarvis";

export class ElectronClientError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseElectronClientConfig(env = process.env) {
  for (const key of ["JARVIS_DB", "JARVIS_RUNTIME_HOME", "JARVIS_TEST_RUNTIME_HOME"]) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      throw new ElectronClientError("ELECTRON_LOCAL_AUTHORITY_FORBIDDEN");
    }
  }
  const raw = env.JARVIS_AUTHORITY_URL;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ElectronClientError("LINUX_AUTHORITY_URL_REQUIRED");
  }
  let authorityUrl;
  try {
    authorityUrl = new URL(raw);
  } catch {
    throw new ElectronClientError("LINUX_AUTHORITY_URL_INVALID");
  }
  if (!["http:", "https:"].includes(authorityUrl.protocol) || authorityUrl.username || authorityUrl.password
    || authorityUrl.search || authorityUrl.hash || authorityUrl.pathname !== "/") {
    throw new ElectronClientError("LINUX_AUTHORITY_URL_INVALID");
  }
  return {
    schema_version: 1,
    authority_mode: "remote-only",
    authority_url: authorityUrl.origin,
    shell: "cli-jaw",
    client_host: "host:pos:mac-client",
    protocol_scheme: ELECTRON_PROTOCOL_SCHEME,
  };
}

export function describeElectronShell(env = process.env) {
  const config = parseElectronClientConfig(env);
  return {
    ...config,
    electron_version: ELECTRON_VERSION,
    web_preferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function installedElectron() {
  const packagePath = require.resolve("electron/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  if (metadata.version !== ELECTRON_VERSION) throw new ElectronClientError("ELECTRON_VERSION_MISMATCH");
  return { root: dirname(packagePath), version: metadata.version };
}

export function resolveElectronBinary(env = process.env, platform = process.platform) {
  const explicit = env.ELECTRON_BINARY;
  if (typeof explicit === "string" && explicit.length > 0) {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      throw new ElectronClientError("ELECTRON_BINARY_INVALID");
    }
  }
  const { root } = installedElectron();
  const binary = platform === "darwin"
    ? join(root, "dist", "Electron.app", "Contents", "MacOS", "Electron")
    : platform === "win32"
      ? join(root, "dist", "electron.exe")
      : join(root, "dist", "electron");
  try {
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    throw new ElectronClientError("ELECTRON_BINARY_INVALID");
  }
}

export function moduleDirectory() {
  return dirname(fileURLToPath(import.meta.url));
}
