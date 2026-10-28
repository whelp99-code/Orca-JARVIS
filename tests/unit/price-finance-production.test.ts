import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPriceFinanceRuntime, type PriceHttpExchange } from "../../src/integration/price-finance-production.js";

const company = `company_${"a".repeat(32)}`;
const request = { company_id: company, period_start: "2026-09-01", period_end: "2026-09-30",
  view: "discrepancy" } as const;
const body = '{"items":[],"read_only":true,"live_source_checked":false}';
const roots: string[] = [];
const nativeBinding = {
  candidate: {
    id: "crm_company_binding_unit", revision: 1,
    crm_workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048", price_company_id: company,
    registered_by: "unit-owner", registered_at: "2026-10-08T23:34:51.982364+00:00",
    confirmed_by_human: true, confirmed_by: "owner", confirmation_ref: "unit-owner-decision",
    source_reference: "unit-native-source",
  },
  confirmed_connection: true,
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function credential(change: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "price-reader-unit-"));
  roots.push(root);
  const path = join(root, "credential.json");
  writeFileSync(path, JSON.stringify({
    origin: "http://127.0.0.1:4382", company_id: company, username: `jarvis_price_read_${company}`,
    password: "unit-only-not-a-live-credential", user_id: `user_${"b".repeat(32)}`, ...change,
  }), { mode: 0o600 });
  return path;
}
function exchange(role = "viewer", company_id = company) {
  return vi.fn<PriceHttpExchange>(async input => {
    if (input.url.pathname === "/api/login") return {
      status: 200, cookie: "price_session=unit-session",
      body: JSON.stringify({ csrf: "unit-csrf", companies: [{ id: company_id, role }] }),
    };
    if (input.url.pathname === "/api/logout") return { status: 200, body: '{"ok":true}' };
    return { status: 200, body };
  });
}

const consumers = ["finance", "binding"] as const;
type Consumer = typeof consumers[number];
function read(runtime: ReturnType<typeof createPriceFinanceRuntime>, consumer: Consumer) {
  return consumer === "finance" ? runtime.reader.read(request) : runtime.readCompanyBinding();
}
function success(input: Parameters<PriceHttpExchange>[0]) {
  return { status: 200, body: input.url.pathname.endsWith("/crm-company-binding")
    ? JSON.stringify(nativeBinding) : body };
}

describe("Price viewer session invalidation", () => {
  it.each(consumers)("rejects %s 401 once and authenticates only the next explicit cross-consumer request", async consumer => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    let reads = 0;
    wire.mockImplementation(async input => input.method !== "GET" ? normal(input)
      : ++reads === 1 ? { status: 401, body: "{}" } : success(input));
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try {
      await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
      expect(reads).toBe(1);
      expect(wire.mock.calls.filter(([input]) => input.url.pathname === "/api/login")).toHaveLength(1);
      await read(runtime, consumer === "finance" ? "binding" : "finance");
      expect(reads).toBe(2);
      expect(wire.mock.calls.filter(([input]) => input.url.pathname === "/api/login")).toHaveLength(2);
    } finally { await runtime.close(); }
  });
  it.each(consumers)("bounds repeated %s 401s to one login and one read per explicit request", async consumer => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    wire.mockImplementation(async input => input.method === "GET" ? { status: 401, body: "{}" } : normal(input));
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try {
      for (let count = 1; count <= 3; count++) {
        await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
        expect(wire.mock.calls.filter(([input]) => input.url.pathname === "/api/login")).toHaveLength(count);
        expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(count);
      }
    } finally { await runtime.close(); }
  });
  it.each(consumers.flatMap(consumer => ([403, 404, 409, 429, 500, "transport"] as const).map(status => ({ consumer, status }))))(
    "keeps the session after $consumer $status", async ({ consumer, status }) => {
      const wire = exchange();
      const normal = wire.getMockImplementation();
      if (normal === undefined) throw new Error("wire implementation required");
      const failure = new Error("synthetic transport failure");
      let reads = 0;
      wire.mockImplementation(async input => {
        if (input.method !== "GET") return normal(input);
        if (++reads !== 1) return success(input);
        if (status === "transport") throw failure;
        return { status, body: "{}" };
      });
      const runtime = createPriceFinanceRuntime(credential(), wire);
      try {
        if (status === "transport") await expect(read(runtime, consumer)).rejects.toBe(failure);
        else await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
        await read(runtime, consumer);
        expect(reads).toBe(2);
        expect(wire.mock.calls.filter(([input]) => input.url.pathname === "/api/login")).toHaveLength(1);
      } finally { await runtime.close(); }
    },
  );
  it.each(consumers)("does not let an old concurrent %s 401 clear a newer shared session", async consumer => {
    const started = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<Awaited<ReturnType<PriceHttpExchange>>>();
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    let logins = 0, reads = 0;
    wire.mockImplementation(async input => {
      if (input.url.pathname === "/api/login") logins++;
      if (input.method !== "GET") return normal(input);
      reads++;
      if (reads === 1) { started.resolve(); return delivery.promise; }
      return reads === 2 ? { status: 401, body: "{}" } : success(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    const pending = read(runtime, consumer);
    const denied = expect(pending).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    try {
      await started.promise;
      const other = consumer === "finance" ? "binding" : "finance";
      await expect(read(runtime, other)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
      await read(runtime, other);
      expect(logins).toBe(2);
      delivery.resolve({ status: 401, body: "{}" });
      await denied;
      await read(runtime, consumer);
      expect(logins).toBe(2);
      expect(reads).toBe(4);
    } finally {
      delivery.resolve({ status: 401, body: "{}" });
      await denied;
      await runtime.close();
    }
  });
  it.each(consumers.flatMap(consumer => [
    { role: "owner", company_id: company }, { role: "viewer", company_id: "foreign" },
  ].map(identity => ({ consumer, ...identity }))))("rechecks viewer identity after $consumer invalidation %#", async ({ consumer, role, company_id }) => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    let logins = 0;
    wire.mockImplementation(async input => {
      if (input.url.pathname === "/api/login" && ++logins === 2) return {
        status: 200, cookie: "price_session=unit-invalid-identity",
        body: JSON.stringify({ csrf: "unit-csrf", companies: [{ id: company_id, role }] }),
      };
      return input.method === "GET" ? { status: 401, body: "{}" } : normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try {
      await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
      await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "PRICE_READ_IDENTITY_REFUSED" });
      expect(logins).toBe(2);
      expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(1);
    } finally { await runtime.close(); }
  });
  it.each(consumers)("preserves close fencing while the next %s login is pending", async consumer => {
    const started = Promise.withResolvers<void>();
    const login = Promise.withResolvers<Awaited<ReturnType<PriceHttpExchange>>>();
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    let logins = 0;
    wire.mockImplementation(async input => {
      if (input.url.pathname === "/api/login" && ++logins === 2) { started.resolve(); return login.promise; }
      return input.method === "GET" ? { status: 401, body: "{}" } : normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    const pending = read(runtime, consumer);
    // Also settle the barrier on an incorrectly reused session, so red runs do not hang.
    void pending.catch(() => started.resolve());
    const denied = expect(pending).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_FENCE_CHANGED" });
    await started.promise;
    const closing = runtime.close();
    login.resolve({ status: 200, cookie: "price_session=unit-next",
      body: JSON.stringify({ csrf: "unit-csrf", companies: [{ id: company, role: "viewer" }] }) });
    await Promise.all([closing, denied]);
    expect(logins).toBe(2);
    expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(1);
    const count = wire.mock.calls.length;
    await expect(read(runtime, consumer)).rejects.toBeDefined();
    expect(wire.mock.calls).toHaveLength(count);
  });
  it.each(consumers)("logs out the viewer cookie refused by an upstream %s 401", async consumer => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    wire.mockImplementation(async input => input.method === "GET" ? { status: 401, body: "{}" } : normal(input));
    const runtime = createPriceFinanceRuntime(credential(), wire);
    await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    await runtime.close();
    const logout = wire.mock.calls.map(([input]) => input).find(input => input.url.pathname === "/api/logout");
    expect(logout?.headers.cookie).toBe("price_session=unit-session");
    expect(logout?.headers["x-csrf-token"]).toBe("unit-csrf");
  });
  it.each(consumers)("logs out the retired %s session after the current logout fails", async consumer => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    if (normal === undefined) throw new Error("wire implementation required");
    let logins = 0;
    wire.mockImplementation(async input => {
      if (input.url.pathname === "/api/login") {
        logins += 1;
        return logins === 1
          ? { status: 200, cookie: "price_session=retired-session",
              body: JSON.stringify({ csrf: "retired-csrf", companies: [{ id: company, role: "viewer" }] }) }
          : { status: 200, cookie: "price_session=current-session",
              body: JSON.stringify({ csrf: "current-csrf", companies: [{ id: company, role: "viewer" }] }) };
      }
      if (input.method === "GET" && input.headers.cookie === "price_session=retired-session") return { status: 401, body: "{}" };
      if (input.url.pathname === "/api/logout" && input.headers.cookie === "price_session=current-session") {
        return { status: 503, body: "{}" };
      }
      if (input.method === "GET") return { status: 200, body: consumer === "binding" ? JSON.stringify(nativeBinding) : body };
      return normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    await expect(read(runtime, consumer)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    await expect(read(runtime, consumer)).resolves.toBeDefined();
    await expect(runtime.close()).rejects.toMatchObject({ code: "PRICE_READ_LOGOUT_REFUSED" });
    const logouts = wire.mock.calls.map(([input]) => input).filter(input => input.url.pathname === "/api/logout");
    expect(logouts.map(input => input.headers.cookie)).toEqual([
      "price_session=current-session", "price_session=retired-session",
    ]);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(wire.mock.calls.filter(([input]) => input.url.pathname === "/api/logout")).toHaveLength(2);
  });
});

describe("Price operating finance read composition", () => {
  it("reads native company registration under the existing viewer without financial authority", async () => {
    const raw = JSON.stringify(nativeBinding);
    const wire = exchange();
    const normal = wire.getMockImplementation();
    wire.mockImplementation(async input => {
      if (input.url.pathname.endsWith("/crm-company-binding")) return { status: 200, body: raw };
      if (normal === undefined) throw new Error("wire implementation required");
      return normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try {
      const receipt = await runtime.readCompanyBinding();
      expect(wire.mock.calls.map(([input]) => [input.method, input.url.href])).toEqual([
        ["POST", "http://127.0.0.1:4382/api/login"],
        ["GET", `http://127.0.0.1:4382/api/companies/${company}/crm-company-binding`],
      ]);
      expect(receipt.response_body).toBe(raw);
      expect(receipt.source_revision).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);
      expect(receipt.data).toEqual(nativeBinding);
      expect(receipt.freshness).toBe("producer_unverified");
      expect(JSON.stringify(receipt)).not.toContain("unit-session");
      expect(JSON.stringify(receipt)).not.toContain("unit-only-not-a-live-credential");
    } finally { await runtime.close(); }
  });
  it.each([
    { value: { ...nativeBinding, candidate: { ...nativeBinding.candidate, price_company_id: "foreign" } },
      code: "CORE5_NATIVE_READ_SCOPE_DENIED" },
    { value: { ...nativeBinding, confirmed_connection: false }, code: "CORE5_NATIVE_READ_RESPONSE_INVALID" },
  ])("refuses a foreign or contradictory native registration %#", async ({ value, code }) => {
    const wire = exchange();
    const normal = wire.getMockImplementation();
    wire.mockImplementation(async input => {
      if (input.url.pathname.endsWith("/crm-company-binding")) return { status: 200, body: JSON.stringify(value) };
      if (normal === undefined) throw new Error("wire implementation required");
      return normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try { await expect(runtime.readCompanyBinding()).rejects.toMatchObject({ code }); }
    finally { await runtime.close(); }
  });
  it("discards registration delivered after the runtime closes", async () => {
    const reading = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<Awaited<ReturnType<PriceHttpExchange>>>();
    const wire = exchange();
    const normal = wire.getMockImplementation();
    wire.mockImplementation(async input => {
      if (input.method === "GET") { reading.resolve(); return delivery.promise; }
      if (normal === undefined) throw new Error("wire implementation required");
      return normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    const pending = runtime.readCompanyBinding();
    const denied = expect(pending).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_FENCE_CHANGED" });
    await reading.promise;
    await runtime.close();
    delivery.resolve({ status: 200, body: JSON.stringify(nativeBinding) });
    await denied;
  });
  it("uses its own viewer login and preserves exact native bytes and SHA", async () => {
    const wire = exchange();
    const runtime = createPriceFinanceRuntime(credential(), wire);
    try {
      const receipt = await runtime.reader.read(request);
      expect(wire.mock.calls.map(([input]) => [input.method, input.url.href])).toEqual([
        ["POST", "http://127.0.0.1:4382/api/login"],
        ["GET", `http://127.0.0.1:4382/api/companies/${company}/discrepancies`],
      ]);
      expect(wire.mock.calls[1]?.[0].headers.cookie).toBe("price_session=unit-session");
      expect(receipt.response_body).toBe(body);
      expect(receipt.source_revision).toBe(`sha256:${createHash("sha256").update(body).digest("hex")}`);
      expect(JSON.stringify(receipt)).not.toContain("unit-session");
      expect(JSON.stringify(receipt)).not.toContain("unit-only-not-a-live-credential");
    } finally { await runtime.close(); }
    expect(wire.mock.calls.at(-1)?.[0].url.pathname).toBe("/api/logout");
  });
  it("refuses another company before authenticating or calling Price", async () => {
    const wire = exchange();
    const runtime = createPriceFinanceRuntime(credential(), wire);
    await expect(runtime.reader.read({ ...request, company_id: "foreign" }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_READ_SCOPE_DENIED" });
    expect(wire).not.toHaveBeenCalled();
    await runtime.close();
  });
  it.each([{ role: "owner", company_id: company }, { role: "viewer", company_id: "foreign" }])(
    "refuses a successful login outside the issued viewer scope %#", async identity => {
      const wire = exchange(identity.role, identity.company_id);
      const runtime = createPriceFinanceRuntime(credential(), wire);
      await expect(runtime.reader.read(request)).rejects.toMatchObject({ code: "PRICE_READ_IDENTITY_REFUSED" });
      expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(0);
      expect(wire.mock.calls.at(-1)?.[0].url.pathname).toBe("/api/logout");
      await runtime.close();
    },
  );
  it.each([401, 403, 404, 409, 500])("does not retry or fabricate data after native status %s", async status => {
    const wire = exchange();
    wire.mockImplementation(async input => input.url.pathname === "/api/login"
      ? { status: 200, cookie: "price_session=unit-session",
        body: JSON.stringify({ csrf: "unit-csrf", companies: [{ id: company, role: "viewer" }] }) }
      : input.url.pathname === "/api/logout" ? { status: 200, body: '{"ok":true}' }
        : { status, body: "{}" });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    await expect(runtime.reader.read(request)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(1);
    await runtime.close();
  });
  it.each([{ origin: "http://127.0.0.1:4381" }, { username: "human-owner" }, { company_id: "foreign" }])(
    "rejects an unregistered credential descriptor %#", change => {
      const wire = exchange();
      expect(() => createPriceFinanceRuntime(credential(change), wire)).toThrow("PRICE_READ_CREDENTIAL_INVALID");
      expect(wire).not.toHaveBeenCalled();
    },
  );
  it("rejects a public or symlink credential before using its contents", () => {
    const path = credential();
    chmodSync(path, 0o644);
    expect(() => createPriceFinanceRuntime(path)).toThrow("PRICE_READ_CREDENTIAL_INVALID");
    chmodSync(path, 0o600);
    const alias = path + ".link";
    symlinkSync(path, alias);
    expect(() => createPriceFinanceRuntime(alias)).toThrow("PRICE_READ_CREDENTIAL_INVALID");
  });
  it("accepts service-owned 0400 only in the systemd credential directory", async () => {
    const path = credential();
    chmodSync(path, 0o400);
    expect(() => createPriceFinanceRuntime(path)).toThrow("PRICE_READ_CREDENTIAL_INVALID");
    vi.stubEnv("CREDENTIALS_DIRECTORY", path + "/..");
    // The marker must be the exact canonical parent, not a normalized assertion.
    expect(() => createPriceFinanceRuntime(path)).toThrow("PRICE_READ_CREDENTIAL_INVALID");
    vi.stubEnv("CREDENTIALS_DIRECTORY", path.slice(0, path.lastIndexOf("/")));
    const runtime = createPriceFinanceRuntime(path, exchange());
    expect((await runtime.reader.read(request)).response_body).toBe(body);
    await runtime.close();
  });
  it("discards a completed read when the runtime closes during delivery", async () => {
    const reading = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<Awaited<ReturnType<PriceHttpExchange>>>();
    const wire = exchange();
    const normal = wire.getMockImplementation();
    wire.mockImplementation(async input => {
      if (input.method === "GET") { reading.resolve(); return delivery.promise; }
      if (normal === undefined) throw new Error("wire implementation required");
      return normal(input);
    });
    const runtime = createPriceFinanceRuntime(credential(), wire);
    const pending = runtime.reader.read(request);
    const denied = expect(pending).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_FENCE_CHANGED" });
    await reading.promise;
    await runtime.close();
    delivery.resolve({ status: 200, body });
    await denied;
  });
});
