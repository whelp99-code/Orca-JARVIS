import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_HOST } from "./dashboard-fixture-ids.js";
import { startDashboardFixture, type StartedFixture } from "./dashboard-fixture-runtime.js";

type CliOptions = {
  readonly host: string;
  readonly port: number;
  readonly metadataPath: string;
  readonly staticRoot: string;
  readonly emptyPort?: number;
  readonly emptyMetadataPath?: string;
};

function requiredArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function optionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function parseCli(): CliOptions {
  const emptyPortValue = optionalArg("empty-port");
  return {
    host: optionalArg("host") ?? FIXTURE_HOST,
    port: Number(requiredArg("port")),
    metadataPath: requiredArg("metadata"),
    staticRoot: optionalArg("static-root") ?? resolve("dist/dashboard"),
    emptyPort: emptyPortValue === undefined ? undefined : Number(emptyPortValue),
    emptyMetadataPath: optionalArg("empty-metadata"),
  };
}

function emitPaths(options: CliOptions, seeded: StartedFixture, empty: StartedFixture | undefined): void {
  process.stdout.write(`${JSON.stringify({
    seeded: { url: seeded.metadata.url, metadata: resolve(options.metadataPath), port: seeded.metadata.port },
    empty: empty === undefined || options.emptyMetadataPath === undefined
      ? null
      : { url: empty.metadata.url, metadata: resolve(options.emptyMetadataPath), port: empty.metadata.port },
  })}\n`);
}

async function main(): Promise<void> {
  const options = parseCli();
  if (options.host !== FIXTURE_HOST) throw new Error("fixture host must be 127.0.0.1");
  const empty = options.emptyPort === undefined ? undefined : await startDashboardFixture({
    host: options.host,
    port: options.emptyPort,
    staticRoot: options.staticRoot,
    metadataPath: options.emptyMetadataPath ?? resolve(".tmp-e2e/empty.json"),
    seed: false,
  });
  const seeded = await startDashboardFixture({
    host: options.host,
    port: options.port,
    staticRoot: options.staticRoot,
    metadataPath: options.metadataPath,
    seed: true,
  });
  const fixtures = empty === undefined ? [seeded] : [empty, seeded];
  const shutdown = (): void => {
    for (const fixture of fixtures) {
      try { fixture.close(); } catch { /* already closed */ }
      rmSync(fixture.env.tempRoot, { recursive: true, force: true });
    }
    rmSync(resolve(options.metadataPath), { force: true });
    if (options.emptyMetadataPath !== undefined) rmSync(resolve(options.emptyMetadataPath), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  emitPaths(options, seeded, empty);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
