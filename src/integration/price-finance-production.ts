import { constants, openSync, readFileSync, closeSync, fstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";
import { NativeFinanceReader, type NativeFinanceReadTransport } from "./native-finance-read.js";
import { priceCompanyBindingSourceSchema, type PriceCompanyBindingReceipt } from "./price-finance-contract.js";

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
  readCompanyBinding(): Promise<PriceCompanyBindingReceipt>;
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
  const retired: Promise<Readonly<{ cookie: string; csrf: string }>>[] = [];
  function invalidate(usedSession: Promise<Readonly<{ cookie: string; csrf: string }>>) {
    if (session !== usedSession) return;
    retired.push(usedSession);
    session = undefined;
  }
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
      const usedSession = session;
      const own = await usedSession;
      if (closed) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
      const url = new URL(input.path, ORIGIN);
      for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
      if (url.origin !== ORIGIN || !allowed.includes(url.pathname)) throw new JarvisError("CORE5_NATIVE_READ_SCOPE_DENIED");
      const response = await exchange({ method: "GET", url, headers: { cookie: own.cookie, accept: "application/json" } });
      if (response.status === 401) invalidate(usedSession);
      return { status: response.status, body: response.body };
    },
  };
  return {
    company_id: credential.company_id,
    reader: new NativeFinanceReader(credential.company_id, transport, () => closed ? "closed" : fence),
    async readCompanyBinding() {
      if (closed) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
      session ??= authenticate();
      const usedSession = session;
      const own = await usedSession;
      if (closed) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
      // Identity metadata is separate from the three frozen finance.read views.
      const response = await exchange({
        method: "GET", url: new URL(`/api/companies/${credential.company_id}/crm-company-binding`, ORIGIN),
        headers: { cookie: own.cookie, accept: "application/json" },
      });
      if (closed) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
      if (response.status === 401) invalidate(usedSession);
      if (response.status !== 200) throw new JarvisError("CORE5_NATIVE_READ_REFUSED");
      let value: unknown;
      try { value = JSON.parse(response.body); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
      }
      const parsed = priceCompanyBindingSourceSchema.safeParse(value);
      if (!parsed.success) throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
      if (parsed.data.candidate !== null && parsed.data.candidate.price_company_id !== credential.company_id) {
        throw new JarvisError("CORE5_NATIVE_READ_SCOPE_DENIED");
      }
      return {
        schema_version: 1, company_id: credential.company_id,
        source_revision: `sha256:${createHash("sha256").update(response.body).digest("hex")}`,
        observed_at: new Date().toISOString(), freshness: "producer_unverified",
        receipt_kind: "response_body_integrity_not_signed", response_body: response.body, data: parsed.data,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const issued = session === undefined ? [...retired] : [session, ...retired];
      session = undefined;
      retired.length = 0;
      const failures: unknown[] = [];
      for (const issuedSession of issued) {
        let own: Awaited<typeof issuedSession>;
        try { own = await issuedSession; }
        catch { continue; } // A refused login created no usable session to revoke.
        try {
          const response = await exchange({
            method: "POST", url: new URL("/api/logout", ORIGIN),
            headers: { cookie: own.cookie, "x-csrf-token": own.csrf, "content-type": "application/json" }, body: "{}",
          });
          if (response.status !== 200) failures.push(new JarvisError("PRICE_READ_LOGOUT_REFUSED"));
        } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
