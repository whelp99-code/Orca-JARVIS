import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import type { MailCandidatesSummary } from "../../src/integration/mail-candidates-contract.js";
import type { PersonalSourceSnapshot } from "../../src/personal-connector-types.js";
import { readProductHub, type ProductHubRead } from "../../src/dashboard/product-hub-routes.js";
import { productHubSchema } from "../../src/dashboard/product-hub-contract.js";

const NOW = "2026-10-16T00:00:00.000Z";
const now = new Date(NOW);
const clock = () => now;

function nativeSummary(crmCount: number, sbCount: number | "refused" | "absent"): MailCandidatesSummary {
  const sb = sbCount === "refused"
    ? { state: "unconnected" as const, reason: "refused" as const }
    : sbCount === "absent"
      ? { state: "unconnected" as const, reason: "unconfigured" as const }
      : { state: "read" as const, workspace_id: "11111111-1111-4111-8111-111111111111", candidate_count: sbCount };
  const crm = crmCount === 0
    ? { state: "read" as const, workspace_id: "22222222-2222-4222-8222-222222222222", candidate_count: 0, recent: [] }
    : {
      state: "read" as const, workspace_id: "22222222-2222-4222-8222-222222222222", candidate_count: crmCount,
      recent: Array.from({ length: Math.min(crmCount, 5) }, (_, index) => ({
        id: `secret-candidate-${index}`, status: "open", confirmed: false, freshness: "live", createdAt: NOW,
      })),
    };
  return {
    schema_version: 1, proof_level: "native-read", authority: "none", observed_at: NOW, crm, sb,
  };
}

function snapshot(status: PersonalSourceSnapshot["status"], values: PersonalSourceSnapshot["values"], fresh = true): PersonalSourceSnapshot {
  return {
    connector_id: "mail", source_version: "test", incarnation: null, sequence: 1, cursor: "cursor-secret",
    observed_at: NOW, fresh_until: fresh ? "2026-10-16T00:01:00.000Z" : "2026-10-15T00:00:00.000Z",
    status, evidence_refs: ["evidence-secret"], values,
  };
}

async function project(input: Omit<ProductHubRead, "clock" | "priceConfigured" | "memoryConfigured"> & Partial<Pick<ProductHubRead, "priceConfigured" | "memoryConfigured">>) {
  const body = await readProductHub({ clock, priceConfigured: false, memoryConfigured: false, ...input });
  return productHubSchema.parse(body);
}

describe("product hub projection", () => {
  it("keeps verified counts and drops provider identities", async () => {
    const db = new AuthorityDb(":memory:");
    await db.migrate();
    new MemoryProjectionAuthority(db).initialize(now);
    try {
      const body = await project({
        db, priceConfigured: true, memoryConfigured: true,
        mailCandidates: { read: async () => nativeSummary(2, 4) },
        mailSource: { read: async () => ({ ...snapshot("current", {
          message_count: 11, thread_count: 3, observed_at: NOW, href: "https://secret.example/mail",
        }), connector_id: "mail" }) },
        messengerSource: { read: async () => ({ ...snapshot("current", {
          incomplete_count: 2, oldest_incomplete_age_ms: 40, scope: "secret-scope",
        }), connector_id: "messenger" }) },
      });
      expect(body.items.map(item => item.id)).toEqual(["crm", "mail", "price", "second_brain", "messenger", "approvals"]);
      expect(body.items[0]).toEqual({ id: "crm", state: "ready", observed_at: NOW, count: 2, secondary_count: null, oldest_age_ms: null });
      expect(body.items[1]).toEqual({ id: "mail", state: "ready", observed_at: NOW, count: 11, secondary_count: 3, oldest_age_ms: null });
      expect(body.items[2]).toEqual({ id: "price", state: "configured", observed_at: null, count: null, secondary_count: null, oldest_age_ms: null });
      expect(body.items[3]).toEqual({ id: "second_brain", state: "ready", observed_at: NOW, count: 4, secondary_count: null, oldest_age_ms: null });
      expect(body.items[4]).toEqual({ id: "messenger", state: "ready", observed_at: NOW, count: 2, secondary_count: null, oldest_age_ms: 40 });
      expect(body.items[5]).toEqual({ id: "approvals", state: "no_data", observed_at: null, count: 0, secondary_count: null, oldest_age_ms: null });
      const wire = JSON.stringify(body);
      expect(wire).not.toContain("secret");
      expect(wire).not.toContain("workspace");
      expect(wire).not.toContain("href");
      expect(wire).not.toContain("scope");
    } finally { db.close(); }
  });

  it("uses nulls for missing sources and configured memory without a candidate count", async () => {
    const db = new AuthorityDb(":memory:");
    await db.migrate();
    try {
      const body = await project({ db, memoryConfigured: true, priceConfigured: false });
      expect(body.items.find(item => item.id === "crm")).toMatchObject({ state: "unconfigured", count: null });
      expect(body.items.find(item => item.id === "second_brain")).toEqual({
        id: "second_brain", state: "configured", observed_at: null, count: null, secondary_count: null, oldest_age_ms: null,
      });
      expect(body.items.find(item => item.id === "mail")?.state).toBe("unconfigured");
      expect(body.items.find(item => item.id === "price")?.state).toBe("unconfigured");
    } finally { db.close(); }
  });

  it("does not treat an isolated fixture or a stale empty read as a live zero", async () => {
    const db = new AuthorityDb(":memory:");
    await db.migrate();
    try {
      const fixture: MailCandidatesSummary = {
        schema_version: 1, proof_level: "isolated-fixture", authority: "none", observed_at: NOW,
        crm: { state: "read", workspace_id: "33333333-3333-4333-8333-333333333333", candidate_count: 9, recent: [] },
        sb: { state: "read", workspace_id: "33333333-3333-4333-8333-333333333333", candidate_count: 9 },
      };
      const body = await project({
        db,
        mailCandidates: { read: async () => fixture },
        mailSource: { read: async () => snapshot("no_data", {}, false) },
        messengerSource: { read: async () => ({ ...snapshot("stale", { incomplete_count: 5, oldest_incomplete_age_ms: 8 }), connector_id: "messenger" }) },
      });
      expect(body.items.find(item => item.id === "crm")).toMatchObject({ state: "unavailable", count: null });
      expect(body.items.find(item => item.id === "second_brain")).toMatchObject({ state: "unavailable", count: null });
      expect(body.items.find(item => item.id === "mail")).toMatchObject({ state: "unavailable", count: null, secondary_count: null });
      expect(body.items.find(item => item.id === "messenger")).toMatchObject({ state: "stale", count: 5, oldest_age_ms: 8 });
      const aged = await project({
        db,
        messengerSource: { read: async () => ({ ...snapshot("current", { incomplete_count: 2, oldest_incomplete_age_ms: 10 }), connector_id: "messenger", observed_at: "2026-10-15T23:58:00.000Z" }) },
        mailSource: { read: async () => snapshot("no_data", {}) },
      });
      expect(aged.items.find(item => item.id === "messenger")).toMatchObject({ state: "unavailable", count: null, oldest_age_ms: null });
      expect(aged.items.find(item => item.id === "mail")).toMatchObject({ state: "no_data", count: 0, secondary_count: 0, observed_at: NOW });
    } finally { db.close(); }
  });

  it("keeps sibling cards when one reader fails and refuses unknown errors", async () => {
    const db = new AuthorityDb(":memory:");
    await db.migrate();
    try {
      const denied = await project({
        db,
        mailCandidates: { read: async () => nativeSummary(1, "refused") },
        mailSource: { read: async () => { throw new JarvisError("MAIL_READ_REFUSED"); } },
        messengerSource: { read: async () => { throw new JarvisError("MESSENGER_READ_RESPONSE_INVALID"); } },
      });
      expect(denied.items.find(item => item.id === "crm")?.state).toBe("ready");
      expect(denied.items.find(item => item.id === "second_brain")?.state).toBe("denied");
      expect(denied.items.find(item => item.id === "mail")?.state).toBe("unavailable");
      expect(denied.items.find(item => item.id === "messenger")?.state).toBe("unavailable");
      const scoped = await project({
        db,
        mailCandidates: { read: async () => { throw new JarvisError("CRM_CANDIDATE_SCOPE_DENIED"); } },
        mailSource: { read: async () => snapshot("current", { message_count: 1, thread_count: 1, observed_at: NOW }) },
      });
      expect(scoped.items.find(item => item.id === "crm")?.state).toBe("denied");
      expect(scoped.items.find(item => item.id === "second_brain")?.state).toBe("unavailable");
      expect(scoped.items.find(item => item.id === "mail")?.state).toBe("ready");
      await expect(project({
        db,
        mailSource: { read: async () => { throw new Error("boom"); } },
      })).rejects.toThrow("boom");
    } finally { db.close(); }
  });

  it("counts only visible pending controls and does not write", async () => {
    const db = new AuthorityDb(":memory:");
    await db.migrate();
    new MemoryProjectionAuthority(db).initialize(now);
    const insert = db.db.prepare(`INSERT INTO control_command_requests
      (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES (?,'workflow.start',2,'{}','{}',?,1,'test',?,?,?,'pending',?)`);
    insert.run("visible", "sha256:" + "ab".repeat(32), NOW, "2026-10-17T00:00:00.000Z", "n1", NOW);
    insert.run("hidden", "sha256:" + "cd".repeat(32), NOW, "2026-10-17T00:00:00.000Z", "n2", NOW);
    db.db.prepare(`INSERT INTO memory_projection_quarantine
      (projection_kind,projection_id,component_id,reason_code,detected_at) VALUES ('control_payload',?,?,?,?)`)
      .run("hidden", "hidden", "lineage_unresolved", NOW);
    const before = db.db.serialize();
    try {
      const body = await project({ db });
      expect(body.items.find(item => item.id === "approvals")).toMatchObject({ state: "ready", count: 1 });
      expect(db.db.serialize().equals(before)).toBe(true);
    } finally { db.close(); }
  });
});
