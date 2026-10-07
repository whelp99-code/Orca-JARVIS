import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { CompanyArchiveReader, type CompanyArchiveReadBinding } from "../../src/integration/company-archive-read.js";

const NOW = new Date("2026-10-06T00:00:00.000Z");
const rawSource = ' \n{"authority":"ARCHIVE_PROJECTION_ONLY","money":"9007199254740993"}\n';
const hash = (domain: string, value: unknown) =>
  `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
const binding: CompanyArchiveReadBinding = {
  workspace_id: "b1111111-1111-4111-8111-111111111111", candidate_id: "crm:v2:fixture",
  source_locator: "cwos:v2:fixture", source_event_id: "normalized:fixture",
  content_digest: `sha256:${createHash("sha256").update(rawSource).digest("hex")}`,
  locator: { approved: "false", authority: "ARCHIVE_PROJECTION_ONLY", plan_version: 1 },
  provider_instance_id: "provider:fixture", principal_id: "principal:fixture",
  agent_id: "agent:fixture", session_id: "session:fixture", projects: ["project:fixture"],
  policy_revision: "policy:fixture", deletion_sequence: 0, deletion_set_root: `sha256:${"a".repeat(64)}`,
};
function request() {
  const argumentsValue = { candidate_id: binding.candidate_id };
  return {
    arguments: argumentsValue,
    authority: {
      schema_version: 1, provider_instance_id: binding.provider_instance_id,
      workspace_id: binding.workspace_id, principal_id: binding.principal_id,
      agent_id: binding.agent_id, session_id: binding.session_id, projects: [...binding.projects],
      policy_revision: binding.policy_revision, operation: "read", purpose: "company_memory_read",
      request_digest: hash("second-brain/company-memory-request/v1\0", { operation: "read", arguments: argumentsValue }),
      deletion_sequence: binding.deletion_sequence, deletion_set_root: binding.deletion_set_root,
      issued_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: "fixture:read", signing_key_id: "fixture:key", signature: "native-verifier-owns-signature-check",
    },
  };
}
function candidateResult() {
  return {
    workspace_id: binding.workspace_id, candidate_id: binding.candidate_id,
    source_system: "crm", source_locator: binding.source_locator, source_event_id: binding.source_event_id,
    content: rawSource, content_digest: binding.content_digest, parser_version: "crm:normalized-archive:1",
    locator: { ...binding.locator },
    access: { owner: binding.principal_id, projects: [...binding.projects], policy_revision: binding.policy_revision },
    deletion_sequence: binding.deletion_sequence, deletion_set_root: binding.deletion_set_root,
    state: "candidate", accepted_at: null, rejected_at: null, processed_at: null,
  };
}
function receipt() { return { receipt: seal(candidateResult()) }; }
function seal(result: ReturnType<typeof candidateResult>) {
  const body = {
    schema_version: 1, workspace_id: binding.workspace_id,
    request_digest: request().authority.request_digest, operation: "read",
    candidate_id: binding.candidate_id, result, created_at: NOW.toISOString(),
  };
  const receipt_digest = hash("second-brain/company-memory-receipt/v1\0", body);
  return { workspace_id: body.workspace_id, request_digest: body.request_digest,
    operation: body.operation, candidate_id: body.candidate_id, result: body.result,
    created_at: body.created_at, receipt_digest, receipt_id: `cmreceipt:v1:${receipt_digest.slice(7)}` };
}
function reader(response = receipt()) {
  const calls: Uint8Array[] = [];
  const client = new CompanyArchiveReader(binding, {
    async invoke(bytes) {
      calls.push(bytes);
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0) };
    },
  }, () => "local:1", () => NOW);
  return { client, calls };
}

describe("company archive read boundary", () => {
  it("checks the native receipt and retains exact original bytes without promoting the candidate", async () => {
    const { client, calls } = reader();
    const actual = await client.read(request(), "local:1");
    expect(actual.result.content).toBe(rawSource);
    expect(actual.result.state).toBe("candidate");
    expect(actual.result.locator["approved"]).toBe("false");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(Buffer.from(calls[0] ?? []).toString()).authority.operation).toBe("read");
  });
  it.each(["accept", "reject", "mark_processed", "receive"])("refuses native mutation %s before invoking the CLI", async operation => {
    const { client, calls } = reader(), value = request();
    await expect(client.read({ ...value, authority: { ...value.authority, operation } }, "local:1"))
      .rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });
  it.each(["workspace_id", "principal_id", "policy_revision", "request_digest"])("rejects altered %s before native invocation", async field => {
    const { client, calls } = reader(), value = request();
    await expect(client.read({ ...value, authority: { ...value.authority,
      [field]: field === "workspace_id" ? "22345678-1234-4234-8234-123456789abc"
        : field === "request_digest" ? `sha256:${"b".repeat(64)}` : "foreign",
    } }, "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_SCOPE_DENIED" });
    expect(calls).toHaveLength(0);
  });
  it.each(["source_event_id", "content", "content_digest"])("rejects a resealed native result with changed %s", async field => {
    const response = receipt();
    const changed = { ...response.receipt.result,
      [field]: field === "content_digest" ? `sha256:${"b".repeat(64)}` : "changed" };
    const { client } = reader({ receipt: seal(changed) });
    await expect(client.read(request(), "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_RECEIPT_MISMATCH" });
  });
  it("rejects an unsealed receipt change", async () => {
    const response = receipt();
    response.receipt.result.source_event_id = "forged";
    await expect(reader(response).client.read(request(), "local:1"))
      .rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_RECEIPT_MISMATCH" });
  });
  it("refuses boolean approval promotion even with a recomputed receipt digest", async () => {
    const response = receipt();
    const { client } = reader({ receipt: seal({ ...response.receipt.result, locator: { approved: "true" } }) });
    await expect(client.read(request(), "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_RECEIPT_MISMATCH" });
  });
  it("discards a native response after local delivery fence invalidation", async () => {
    let localFence = "local:1";
    const client = new CompanyArchiveReader(binding, {
      async invoke() {
        localFence = "local:2";
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(receipt())), stderr: Buffer.alloc(0) };
      },
    }, () => localFence, () => NOW);
    await expect(client.read(request(), "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_FENCE_STALE" });
  });
  it("discards a response when authority expires during the exact native invocation", async () => {
    let now = NOW;
    const client = new CompanyArchiveReader(binding, {
      async invoke() {
        now = new Date(request().authority.expires_at);
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(receipt())), stderr: Buffer.alloc(0) };
      },
    }, () => "local:1", () => now);
    await expect(client.read(request(), "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_AUTHORITY_EXPIRED" });
  });
  it("propagates native signature rejection without a retry or fallback", async () => {
    let calls = 0;
    const client = new CompanyArchiveReader(binding, {
      async invoke() { calls++; return { exitCode: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('{"error":"COMPANY_AUTHORITY_REQUIRED"}') }; },
    }, () => "local:1", () => NOW);
    await expect(client.read(request(), "local:1")).rejects.toMatchObject({ code: "CORE5_ARCHIVE_READ_NATIVE_DENIED" });
    expect(calls).toBe(1);
  });
});
