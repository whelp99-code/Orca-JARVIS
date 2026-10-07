import { constants, openSync, readFileSync, closeSync, fstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";
import { NativeFinanceReader, type NativeFinanceReadTransport } from "./native-finance-read.js";

const ORIGIN = "http://127.0.0.1:4382";
const credentialSchema = z.object({
  origin: z.literal(ORIGIN),
  company_id: z.string().regex(/^company_[a-f0-9]{32}$/),
  username: z.string().min(1),
  password: z.string().min(1),
  user_id: z.string().regex(/^user_[a-f0-9]{32}$/),
}).strict().refine(value => value.username === `jarvis_price_read_${value.company_id}`);
const loginSchema = z.object({
  csrf: z.string().min(1),
  companies: z.array(z.object({ id: z.string(), role: z.literal("viewer") })).length(1),
});

export type PriceHttpExchange = (input: Readonly<{
  method: "GET" | "POST"; url: URL; headers: Readonly<Record<string, string>>; body?: string;
}>) => Promise<Readonly<{ status: number; body: string; cookie?: string }>>;

/** No redirects, automatic retries, credential logging, or unbounded responses. */
export const priceHttpExchange: PriceHttpExchange = input => new Promise((resolve, reject) => {
  const fail = () => reject(new JarvisError("PRICE_READ_TRANSPORT_FAILED"));
  const outgoing = request(input.url, {
    method: input.method, headers: input.headers, timeout: 15_000, signal: AbortSignal.timeout(15_000),
  }, incoming => {
    const chunks: Buffer[] = [];
    let length = 0;
    incoming.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) {
        incoming.destroy();
        outgoing.destroy();
        fail();
      } else chunks.push(chunk);
    });
    incoming.on("error", fail);
    incoming.on("end", () => {
      const cookie = incoming.headers["set-cookie"]?.find(value => value.startsWith("price_session="))?.split(";")[0];
      resolve({ status: incoming.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8"),
        ...(cookie === undefined ? {} : { cookie }) });
    });
  });
  outgoing.on("timeout", () => { outgoing.destroy(); fail(); });
  outgoing.on("error", fail);
  outgoing.end(input.body);
});

function readCredential(path: string) {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) {
    throw new JarvisError("PRICE_READ_CREDENTIAL_INVALID");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const mode = stat.mode & 0o777;
    // systemd LoadCredential materializes a service-owned, read-only runtime file.
    // The Price-issued source remains 0600 and is referenced only by the unit.
    const systemdCredential = process.env.CREDENTIALS_DIRECTORY === dirname(path) && mode === 0o400;
    if (!stat.isFile() || (mode !== 0o600 && !systemdCredential)
      || stat.uid !== process.getuid?.() || stat.size > 8192) {
      throw new JarvisError("PRICE_READ_CREDENTIAL_INVALID");
    }
    const parsed = credentialSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success) throw new JarvisError("PRICE_READ_CREDENTIAL_INVALID");
    return parsed.data;
  } finally { closeSync(fd); }
}

export type PriceFinanceRuntime = Readonly<{
  company_id: string;
  reader: NativeFinanceReader;
  close(): Promise<void>;
}>;

/** Only the producer-issued viewer credential is read. Session values remain private in memory. */
export function createPriceFinanceRuntime(
  credentialPath: string, exchange: PriceHttpExchange = priceHttpExchange,
): PriceFinanceRuntime {
  let credential: z.infer<typeof credentialSchema>;
  try { credential = readCredential(credentialPath); }
  catch { throw new JarvisError("PRICE_READ_CREDENTIAL_INVALID"); }
  const fence = randomUUID();
  let closed = false;
  let session: Promise<Readonly<{ cookie: string; csrf: string }>> | undefined;
  async function authenticate() {
    const response = await exchange({
      method: "POST", url: new URL("/api/login", ORIGIN),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: credential.username, password: credential.password }),
    });
    let value: unknown;
    try { value = JSON.parse(response.body); }
    catch { throw new JarvisError("PRICE_READ_IDENTITY_REFUSED"); }
    const identity = loginSchema.safeParse(value);
    if (response.status !== 200 || response.cookie === undefined || !identity.success
      || identity.data.companies[0]?.id !== credential.company_id) {
      const csrf = z.object({ csrf: z.string().min(1) }).safeParse(value);
      if (response.status === 200 && response.cookie !== undefined && csrf.success) {
        await exchange({ method: "POST", url: new URL("/api/logout", ORIGIN),
          headers: { cookie: response.cookie, "x-csrf-token": csrf.data.csrf, "content-type": "application/json" }, body: "{}" });
      }
      throw new JarvisError("PRICE_READ_IDENTITY_REFUSED");
    }
    return { cookie: response.cookie, csrf: identity.data.csrf };
  }
  const transport: NativeFinanceReadTransport = {
    async get(input) {
      const base = `/api/companies/${credential.company_id}`;
      const allowed = [`${base}/owner/reports`, `${base}/discrepancies`, `${base}/event-settlements`];
      const keys = Object.keys(input.query).sort().join(",");
      if (closed || input.method !== "GET" || !allowed.includes(input.path)
        || (input.path.endsWith("/owner/reports") ? keys !== "end,start" : keys !== "")) {
        throw new JarvisError("CORE5_NATIVE_READ_SCOPE_DENIED");
      }
      session ??= authenticate();
      const own = await session;
      if (closed) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
      const url = new URL(input.path, ORIGIN);
      for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
      if (url.origin !== ORIGIN || !allowed.includes(url.pathname)) throw new JarvisError("CORE5_NATIVE_READ_SCOPE_DENIED");
      const response = await exchange({ method: "GET", url, headers: { cookie: own.cookie, accept: "application/json" } });
      return { status: response.status, body: response.body };
    },
  };
  return {
    company_id: credential.company_id,
    reader: new NativeFinanceReader(credential.company_id, transport, () => closed ? "closed" : fence),
    async close() {
      if (closed) return;
      closed = true;
      if (session === undefined) return;
      let own: Awaited<NonNullable<typeof session>>;
      try { own = await session; }
      catch { return; } // A refused login created no usable session to revoke.
      const response = await exchange({
        method: "POST", url: new URL("/api/logout", ORIGIN),
        headers: { cookie: own.cookie, "x-csrf-token": own.csrf, "content-type": "application/json" }, body: "{}",
      });
      if (response.status !== 200) throw new JarvisError("PRICE_READ_LOGOUT_REFUSED");
    },
  };
}
