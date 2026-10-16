import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { companyCheckpointSchema, loadCompanyFreshness } from "../../src/company-freshness.js";
import { companyApproverFixture } from "../fixtures/company-approver-execution.js";

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
    schema_version: 2, role: "freshness", socket: join(root, "broker.sock"),
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
});
