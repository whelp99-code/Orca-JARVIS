import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { canonicalize } from "./canonical.js";
import { parseCompanyJsonBytes } from "./company-candidate-json.js";
import { loadCompanyFreshnessClient } from "./company-freshness-client-config.js";
import { signCompanyFreshnessEnvelope } from "./company-freshness-envelope.js";
import { signCompanyInternalEnvelope } from "./company-internal-envelope.js";
import { JarvisError } from "./jarvis-error.js";

const MAX_BYTES = 1_048_576;

/** Fixed helper for the synchronous provider API; its only effect is the pinned broker exchange. */
export async function exchangeCompanyFreshness(configPath: string, input: unknown): Promise<unknown> {
  const client = loadCompanyFreshnessClient(configPath);
  const parent = lstatSync(dirname(client.config.socket));
  const peer = lstatSync(client.config.socket);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(client.config.socket)) !== dirname(client.config.socket)
    || ![0o700, 0o710].includes(parent.mode & 0o777)
    || !peer.isSocket() || peer.isSymbolicLink() || peer.uid !== parent.uid
    || ![0o600, 0o660].includes(peer.mode & 0o777) || peer.gid !== parent.gid) {
    throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  }
  for (let path = dirname(client.config.socket);; path = dirname(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.() && info.uid !== peer.uid)
      || ((info.mode & 0o022) !== 0 && ((info.mode & 0o1000) === 0 || peer.uid !== process.getuid?.()))) {
      throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    }
    if (path === "/") break;
  }
  const envelope = typeof input === "object" && input !== null && "operation" in input
    ? signCompanyInternalEnvelope(input, client)
    : signCompanyFreshnessEnvelope(input, client);
  const body = canonicalize(envelope);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: client.config.socket, allowHalfOpen: true });
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new JarvisError("COMPANY_FRESHNESS_REQUIRED"));
    };
    const timer = setTimeout(fail, 10_000);
    socket.on("error", fail);
    socket.on("connect", () => socket.end(body));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) fail();
      else chunks.push(chunk);
    });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = parseCompanyJsonBytes(Buffer.concat(chunks));
        if (response === undefined) return fail();
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      } catch { fail(); }
    });
    socket.on("close", () => { if (!settled) fail(); });
  });
}

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { config: { type: "string" } }, strict: true, allowPositionals: false });
    if (values.config === undefined || !values.config.startsWith("/")) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
      chunks.push(bytes);
    }
    const input = parseCompanyJsonBytes(Buffer.concat(chunks));
    const response = canonicalize(await exchangeCompanyFreshness(values.config, input));
    if (Buffer.byteLength(response) > MAX_BYTES) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    process.stdout.write(response);
  } catch {
    process.stderr.write("COMPANY_FRESHNESS_REQUIRED\n");
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) void main();
