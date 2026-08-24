import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { authorityDbFromLaunchAgentXml, defaultJarvisLaunchAgentPath, readLaunchAgentXml } from "./orca-env.js";

export const AUTHORITY_DB_BASENAME = "jarvis.sqlite";
export const RUNTIME_HOME_DIRNAME = ".jarvis-runtime";
export const RUNTIME_SOURCES = ["cli", "env", "service", "repository", "test"] as const;
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number];

export type RuntimeLocation = {
  readonly runtimeHome: string;
  readonly authorityDb: string;
  readonly source: RuntimeSource;
};

export type RuntimeHomeDiscovery = {
  readonly cliRuntimeHome?: string;
  readonly cliAuthorityDb?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly servicePlistPath?: string;
  readonly homedir?: string;
};

export class RuntimeHomeError extends Error {
  readonly name = "RuntimeHomeError";
  constructor(readonly code: "RUNTIME_HOME_CONFLICT" | "RUNTIME_HOME_MISSING", message = code) {
    super(message);
  }
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent), absolute.slice(parent.length).replace(/^\/+/, ""));
  }
}

function locationFromHome(runtimeHome: string, source: RuntimeSource): RuntimeLocation {
  const home = canonicalPath(runtimeHome);
  return { runtimeHome: home, authorityDb: join(home, AUTHORITY_DB_BASENAME), source };
}

function locationFromDb(authorityDb: string, source: RuntimeSource): RuntimeLocation {
  const db = canonicalPath(authorityDb);
  return { runtimeHome: dirname(db), authorityDb: db, source };
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function walkRepositoryRuntimeHome(cwd: string): string | undefined {
  let current = resolve(cwd);
  for (;;) {
    const candidate = join(current, RUNTIME_HOME_DIRNAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function installedServiceDb(discovery: RuntimeHomeDiscovery, env: NodeJS.ProcessEnv): string | undefined {
  const plistPath = discovery.servicePlistPath ?? defaultJarvisLaunchAgentPath(discovery.homedir ?? env.HOME ?? homedir());
  const xml = readLaunchAgentXml(plistPath);
  if (xml === undefined) return undefined;
  return authorityDbFromLaunchAgentXml(xml);
}

export function resolveRuntimeLocation(discovery: RuntimeHomeDiscovery = {}): RuntimeLocation {
  const env = discovery.env ?? process.env;
  const cwd = discovery.cwd ?? process.cwd();
  const cliHome = discovery.cliRuntimeHome;
  const cliDb = discovery.cliAuthorityDb;
  const envHome = env.JARVIS_RUNTIME_HOME;
  const envDb = env.JARVIS_DB;
  const testHome = env.JARVIS_TEST_RUNTIME_HOME;

  if (present(cliHome) && present(cliDb)) {
    const fromHome = locationFromHome(cliHome, "cli");
    if (!samePath(fromHome.authorityDb, cliDb)) throw new RuntimeHomeError("RUNTIME_HOME_CONFLICT");
    return fromHome;
  }
  if (present(cliDb)) return locationFromDb(cliDb, "cli");
  if (present(cliHome)) {
    const fromHome = locationFromHome(cliHome, "cli");
    if (present(envDb) && !samePath(fromHome.authorityDb, envDb)) throw new RuntimeHomeError("RUNTIME_HOME_CONFLICT");
    return fromHome;
  }
  if (present(envHome) && present(envDb)) {
    const fromHome = locationFromHome(envHome, "env");
    if (!samePath(fromHome.authorityDb, envDb)) throw new RuntimeHomeError("RUNTIME_HOME_CONFLICT");
    return fromHome;
  }
  if (present(envHome)) return locationFromHome(envHome, "env");
  if (present(envDb)) return locationFromDb(envDb, "env");

  const serviceDb = installedServiceDb(discovery, env);
  if (present(serviceDb)) return locationFromDb(serviceDb, "service");

  const repositoryHome = walkRepositoryRuntimeHome(cwd);
  if (present(repositoryHome)) return locationFromHome(repositoryHome, "repository");

  if (present(testHome)) return locationFromHome(testHome, "test");

  throw new RuntimeHomeError("RUNTIME_HOME_MISSING");
}
