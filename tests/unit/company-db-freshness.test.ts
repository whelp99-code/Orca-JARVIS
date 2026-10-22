import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as handoffImport from "../../src/company-candidate-import.js";
import { canonicalize } from "../../src/canonical.js";
import { companyCheckpointSchema, loadCompanyFreshness } from "../../src/company-freshness.js";
import { companyApproverFixture, companyApproverKey, companyApproverProcessorContext,
  companyApproverV2Database } from "../fixtures/company-approver-execution.js";
import { configuredCompanyInternalRuntime } from "../../src/company-internal-runtime.js";
import { CompanyDbFreshness } from "../../src/company-db-freshness.js";
import { CompanyProgress } from "../../src/company-progress.js";
import { ControlPlane } from "../../src/control-plane.js";
import { parseCompanyFreshnessPayload } from "../../src/company-freshness-envelope.js";
import { TestOnlyCompanyDbProtocol } from "../fixtures/company-db-protocol.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function client() {
  const root = mkdtempSync(join(tmpdir(), "jfc-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const key = join(root, "progress.pem");
  writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const fixture = companyApproverFixture();
  const command = fixture.command;
  const value = {
    schema_version: 2, role: "freshness", installation_id: "installation:jarvis", socket: join(root, "broker.sock"),
    signing_key_id: "key:company-progress", signing_key_file: key,
    context: {
      provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id,
      principal_id: "principal:jarvis-company-progress", agent_id: "agent:jarvis-progress", session_id: "session:jarvis-progress",
      projects: command.args.projects, policy_revision: command.args.policy_revision,
      deletion_sequence: command.args.deletion_sequence, deletion_set_root: command.args.deletion_set_root,
    },
  };
  const path = join(root, "client.json");
  writeFileSync(path, canonicalize(value), { mode: 0o600 });
  return { root, path, key, value, fixture, config: { schema_version: 2, kind: "sb_company_db", client_config_file: path } };
}

describe("company database freshness configuration", () => {
  it("validates committed cancellation evidence before its production finish transport call", async () => {
    const config = client();
    const live = await companyApproverV2Database("approve", false);
    const now = new Date("2026-10-15T00:05:00.000Z");
    const scope = { provider_instance_id: live.command.target.provider_instance_id, workspace_id: live.command.target.workspace_id };
    const checkpoint = companyCheckpointSchema.parse(JSON.parse(String(live.db.db.prepare(
      "SELECT checkpoint_json FROM company_freshness_checkpoints").pluck().get())));
    const peer = new TestOnlyCompanyDbProtocol(scope, checkpoint);
    const provider = new CompanyDbFreshness(config.path, live.db);
    const finishes: unknown[] = [];
    const transport = vi.spyOn(provider as any, "exchange").mockImplementation((...args: unknown[]) => {
      const [method, request, evidence] = args;
      const parsed = parseCompanyFreshnessPayload({ schema_version: 1, method, request, evidence });
      if (parsed.method === "read_freshness") return peer.readFreshness(parsed.request);
      if (parsed.method === "reserve_progress") return peer.reserveProgress(parsed.request);
      expect(parsed.evidence.kind).toBe("revocation");
      expect(live.db.db.inTransaction).toBe(false);
      expect(() => parseCompanyFreshnessPayload({ ...parsed, request: { ...parsed.request,
        evidence_digest: `sha256:${"a".repeat(64)}` } })).toThrow("COMPANY_CONTRACT_INVALID");
      finishes.push(parsed.evidence);
      return peer.finishProgress(parsed.request);
    });
    try {
      const control = new ControlPlane(live.db, provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_wire_cancel BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY cancelled wire decision'); END`);
      expect(() => control.decide(live.approval, now)).toThrow("TEST_ONLY cancelled wire decision");
      live.db.db.exec("DROP TRIGGER fail_wire_cancel");
      control.cancel({ request_id: live.command.request_id, reason: "cancel before receipt", actor: "test-operator",
        revoked_at: now.toISOString() }, now);
      new CompanyProgress(live.db, provider).settleCancelled(scope, now);
      expect(finishes).toHaveLength(1);
      expect(live.db.db.prepare("SELECT acknowledged FROM company_progress_cancellation_outbox").get())
        .toEqual({ acknowledged: 1 });
      expect(() => live.db.db.prepare("UPDATE company_progress_cancellation_outbox SET evidence_digest=?")
        .run(`sha256:${"a".repeat(64)}`)).toThrow("company cancellation evidence is immutable");
      expect(() => live.db.db.prepare("DELETE FROM company_progress_cancellation_outbox").run())
        .toThrow("company cancellation evidence is immutable");
    } finally { transport.mockRestore(); live.close(); }
  });

  it("advances one bounded handoff page per minute and wraps at the stable count", async () => {
    const live = client();
    const authority = await companyApproverV2Database("approve", false);
    const handoffKey = join(live.root, "handoff.pem");
    writeFileSync(handoffKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const handoff = join(live.root, "handoff.json");
    writeFileSync(handoff, canonicalize({ schema_version: 1, role: "handoff", context: companyApproverProcessorContext(),
      socket: live.value.socket, signing_key_id: "key:handoff-pages", signing_key_file: handoffKey }), { mode: 0o600 });
    const config = join(live.root, "internal.json");
    writeFileSync(config, canonicalize({ schema_version: 1, enabled: true,
      activation_cutoff: "2026-10-16T09:00:00.000Z", report_client_config_file: live.path,
      handoff_client_config_file: handoff }), { mode: 0o600 });
    const offsets: number[] = [];
    const pull = vi.spyOn(handoffImport, "pullCompanyCandidates").mockImplementation(async (_db, _client, limit = 100, offset = 0) => {
      offsets.push(offset);
      return { imported: 0, duplicate: Math.min(limit, 201 - offset), superseded: 0, count: 201, limit, offset };
    });
    let now = new Date("2026-10-16T08:00:00.000Z");
    const runtime = configuredCompanyInternalRuntime(authority.db, config,
      loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" }), () => now, () => {}, code => { throw new Error(code); });
    try {
      if (runtime === undefined) throw new Error("runtime required");
      for (let minute = 0; minute < 4; minute++) {
        now = new Date(Date.parse("2026-10-16T08:00:00.000Z") + minute * 60_000);
        runtime.tick();
        await runtime.close();
      }
      expect(offsets).toEqual([0, 100, 200, 0]);
    } finally { pull.mockRestore(); authority.close(); }
  });
  it.each(["key-id", "material"] as const)("rejects internal report/handoff %s reuse even when C1 is unconfigured", async alias => {
    const live = client();
    const authority = await companyApproverV2Database("approve", false);
    const handoff = join(live.root, "handoff.json");
    const otherKey = join(live.root, "other.pem");
    writeFileSync(otherKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(handoff, canonicalize({ schema_version: 1, role: "handoff", context: companyApproverProcessorContext(),
      socket: live.value.socket, signing_key_id: alias === "key-id" ? live.value.signing_key_id : "key:handoff",
      signing_key_file: alias === "material" ? live.key : otherKey }), { mode: 0o600 });
    const runtime = join(live.root, "internal.json");
    writeFileSync(runtime, canonicalize({ schema_version: 1, enabled: true,
      activation_cutoff: "2026-10-16T00:00:00.000Z", report_client_config_file: live.path,
      handoff_client_config_file: handoff }), { mode: 0o600 });
    try {
      expect(() => configuredCompanyInternalRuntime(authority.db, runtime,
        loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" }),
        () => new Date("2026-10-16T09:00:00.000Z"), () => {}, () => {})).toThrow("COMPANY_CREDENTIAL_NOT_SEPARATE");
    } finally { authority.close(); }
  });

  it("selects the configured provider without invoking SB or opening a company database", () => {
    const live = client();
    const provider = loadCompanyFreshness(live.config);
    expect(provider).toMatchObject({ kind: "sb_company_db" });
  });

  it("keeps configured transport unavailable without a broker, using the existing closed wire errors", () => {
    const live = client();
    const provider = loadCompanyFreshness(live.config);
    const scope = live.fixture.test_only_memory.factory_input.scope;
    const checkpoint = companyCheckpointSchema.parse(live.fixture.test_only_memory.factory_input.initial_checkpoint);
    expect(provider.readFreshness({
      schema_version: 2, scope, installation_id: "installation:jarvis", challenge: "challenge:read",
      observed_checkpoint: checkpoint,
    })).toEqual({ schema_version: 2, scope, challenge: "challenge:read", status: "unavailable", checkpoint: null });
  });

  it("rejects a progress credential with a human principal", () => {
    const live = client();
    writeFileSync(live.path, canonicalize({ ...live.value, context: { ...live.value.context, principal_id: "principal:owner" } }));
    expect(() => loadCompanyFreshness(live.config)).toThrow("COMPANY_FRESHNESS_CONFIG_INVALID");
  });

  it("rejects role substitution and caller-selected database fields", () => {
    const live = client();
    writeFileSync(live.path, canonicalize({ ...live.value, role: "processor", company_database: "/tmp/company.db" }));
    expect(() => loadCompanyFreshness(live.config)).toThrow("COMPANY_FRESHNESS_CONFIG_INVALID");
  });

  it("rejects symlinked or group-readable client credentials", () => {
    const live = client();
    const link = join(live.root, "linked.json");
    symlinkSync(live.path, link);
    expect(() => loadCompanyFreshness({ ...live.config, client_config_file: link }))
      .toThrow("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
    chmodSync(live.path, 0o640);
    expect(() => loadCompanyFreshness(live.config)).toThrow("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
  });

  it("rejects mutable private directories and unknown provider settings", () => {
    const live = client();
    chmodSync(live.root, 0o770);
    expect(() => loadCompanyFreshness(live.config)).toThrow("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
    expect(() => loadCompanyFreshness({ ...live.config, registry: "/tmp/registry.json" })).toThrow("COMPANY_CONTRACT_INVALID");
  });

  it.each(["key-id", "material"] as const)("rejects progress/representative %s reuse with a bound JARVIS database", async alias => {
    const live = client();
    const authority = await companyApproverV2Database("approve", false);
    try {
      if (alias === "key-id") writeFileSync(live.path, canonicalize({
        ...live.value, signing_key_id: live.fixture.approval_receipt.key_id,
      }), { mode: 0o600 });
      else writeFileSync(live.key, companyApproverKey().export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      expect(() => loadCompanyFreshness(live.config, authority.db)).toThrow("COMPANY_CREDENTIAL_NOT_SEPARATE");
    } finally { authority.close(); }
  });
});
