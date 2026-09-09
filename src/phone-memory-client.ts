import { createHash } from "node:crypto";
import { request } from "node:https";
import { dirname, isAbsolute } from "node:path";
import { canonicalize } from "./canonical.js";
import { inspectPrivateSpoolRoot, readPrivateSpoolFile } from "./memory-private-spool-files.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import { validateMemoryBody } from "./phone-gateway-body.js";

const ROUTE = "/api/v1/memory/context";
export class PhoneMemoryClientError extends Error {
  constructor(readonly code: "MEMORY_CLIENT_INPUT_INVALID" | "MEMORY_CLIENT_UNAVAILABLE") { super(code); }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function privateBytes(path: string, maximum: number): Buffer {
  if (!isAbsolute(path)) throw new Error("invalid path");
  return readPrivateSpoolFile(inspectPrivateSpoolRoot(dirname(path)), path, maximum);
}

/** Fixed local credentials file only. No login, renewal, cache, redirects or URL input from the model. */
export async function readPhoneMemoryContext(credentialsPath: string, input: {
  readonly query: string; readonly limit: number; readonly max_bytes: number;
}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify({ schema_version: 1, ...input }));
  if (!validateMemoryBody(ROUTE, payload)) throw new PhoneMemoryClientError("MEMORY_CLIENT_INPUT_INVALID");
  const submitted = JSON.parse(payload.toString("utf8")) as typeof input;
  try {
    const config = parseSecondBrainStrictJsonBytes(privateBytes(credentialsPath, 8192));
    if (!object(config) || ![3, 4].includes(Object.keys(config).length)
      || !Object.keys(config).every(key => ["origin", "cookie_id", "csrf_token", "ca_file"].includes(key))
      || typeof config.origin !== "string" || typeof config.cookie_id !== "string" || typeof config.csrf_token !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(config.cookie_id) || !/^[A-Za-z0-9_-]{43}$/.test(config.csrf_token)) throw new Error("config");
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" || origin.origin !== config.origin || origin.username || origin.password)
      throw new Error("origin");
    const ca = config.ca_file === undefined ? undefined
      : typeof config.ca_file === "string" ? privateBytes(config.ca_file, 262144) : undefined;
    if (config.ca_file !== undefined && ca === undefined) throw new Error("ca");
    const abort = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal === undefined ? [] : [signal])]);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request(new URL(ROUTE, origin), { method: "POST", ca, signal: abort,
        headers: { Origin: config.origin as string, Cookie: `__Host-jarvis-phone=${config.cookie_id as string}`,
          "X-JARVIS-CSRF": config.csrf_token as string, "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.length, Accept: "application/json", Connection: "close" } }, response => {
        const fail = () => { response.destroy(); req.destroy(); reject(new Error("response")); };
        if (response.statusCode !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "")
          || response.headers["content-encoding"] !== undefined) { fail(); return; }
        const length = response.headers["content-length"];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > submitted.max_bytes)) { fail(); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > submitted.max_bytes) fail(); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject); req.end(payload);
    });
    abort.throwIfAborted();
    if (bytes.includes(config.cookie_id) || bytes.includes(config.csrf_token)) throw new Error("credential echo");
    const value = parseSecondBrainStrictJsonBytes(bytes);
    if (!object(value) || value.schema_version !== 1 || value.ok !== true || value.command !== "memory.context"
      || !object(value.context)) throw new Error("envelope");
    const decoded = JSON.stringify(value);
    if (decoded.includes(config.cookie_id) || decoded.includes(config.csrf_token)) throw new Error("credential echo");
    const context = value.context;
    const serialized = canonicalize(context);
    if (context.schema_version !== 1
      || context.query_digest !== `sha256:${createHash("sha256").update(submitted.query).digest("hex")}`
      || context.profile !== "memory-reference-v1" || context.purpose !== "reference_only"
      || context.authority !== "none" || context.trust !== "untrusted" || !Array.isArray(context.records) || context.records.length > submitted.limit
      || value.context_bytes !== Buffer.byteLength(serialized)
      || value.context_digest !== `sha256:${createHash("sha256").update(serialized).digest("hex")}`) throw new Error("context");
    return value;
  } catch { throw new PhoneMemoryClientError("MEMORY_CLIENT_UNAVAILABLE"); }
}
