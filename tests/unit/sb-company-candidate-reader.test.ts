import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalize } from "../../src/canonical.js";
import { createSbCompanyCandidateReader } from "../../src/integration/sb-company-candidate-reader.js";

const fixtures: Array<Readonly<{ root: string; server?: Server; sockets: Socket[] }>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => {
    for (const socket of fixture.sockets) socket.destroy();
    if (fixture.server?.listening) {
      await new Promise<void>(resolve => fixture.server?.close(() => resolve()));
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }));
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-company-candidate-reader-"));
  chmodSync(root, 0o700);
  const sockets: Socket[] = [];
  const state: { root: string; server?: Server; sockets: Socket[] } = { root, sockets };
  fixtures.push(state);
  const keys = generateKeyPairSync("ed25519");
  const keyPath = join(root, "signing-key.pem");
  writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const socketPath = join(root, "company-reader.sock");
  const clientPath = join(root, "client.json");
  const context = {
    provider_instance_id: "provider:unit",
    workspace_id: "e7726a7a-804e-4720-bc9f-dd17a8de6b49",
    principal_id: "principal:jarvis",
    agent_id: "agent:jarvis",
    session_id: "session:unit",
    projects: ["project:unit"],
    policy_revision: "policy:unit",
    deletion_sequence: 7,
    deletion_set_root: `sha256:${"a".repeat(64)}`,
    socket: socketPath,
    signing_key_file: keyPath,
    signing_key_id: "key:unit",
    purpose: "company_memory_read",
    operation: "list_candidates",
  };
  writeFileSync(clientPath, JSON.stringify(context), { mode: 0o600 });
  const server = createServer(socket => {
    sockets.push(socket);
  });
  state.server = server;
  server.listen(socketPath);
  await once(server, "listening");
  return { root, clientPath, context, keys, server, sockets };
}

function validResponse(count = 2) {
  return {
    candidates: [{ candidate_id: "candidate:private", source_event_id: "event:private",
      content_digest: `sha256:${"b".repeat(64)}` }],
    count, limit: 1, offset: 0,
  };
}

function receiveRequest(
  server: Server,
  handle: (socket: Socket, payload: unknown, wire: string) => void,
): Promise<unknown> {
  return new Promise(resolve => {
    server.once("connection", socket => {
      const chunks: Buffer[] = [];
      socket.on("data", chunk => chunks.push(chunk));
      socket.on("end", () => {
        const wire = Buffer.concat(chunks).toString("utf8");
        const payload: unknown = JSON.parse(wire);
        resolve(payload);
        handle(socket, payload, wire);
      });
    });
  });
}

describe("signed SB company candidate reader", () => {
  it("sends canonical wire bytes required by the installed SDK strict loader", async () => {
    const value = await fixture();
    const received = receiveRequest(value.server, (socket, payload, wire) => {
      socket.end(JSON.stringify(wire === canonicalize(payload) ? validResponse() : { error: "JSON_NON_CANONICAL" }));
    });
    await expect(createSbCompanyCandidateReader(value.clientPath).read(new AbortController().signal))
      .resolves.toMatchObject({ state: "read", candidate_count: 2 });
    await received;
  });
  it("accepts the issued descriptor's bound read purpose and operation", async () => {
    const value = await fixture();
    writeFileSync(value.clientPath, JSON.stringify({ ...value.context,
      purpose: "company_memory_read", operation: "list_candidates" }), { mode: 0o600 });
    expect(() => createSbCompanyCandidateReader(value.clientPath)).not.toThrow();
  });
  it("verifies the signed list-only request and projects only workspace and count", async () => {
    // Given: a 0600 client descriptor, Ed25519 key, and local Unix socket server.
    const value = await fixture();
    const received = receiveRequest(value.server, (socket, payload) => {
      const request = z.object({
        authority: z.object({ signature: z.string() }).catchall(z.unknown()),
        arguments: z.unknown(),
      }).parse(payload);
      const { signature, ...authority } = request.authority;
      const expectedDigest = `sha256:${createHash("sha256")
        .update("second-brain/company-memory-request/v1\0")
        .update(canonicalize({ operation: "list_candidates", arguments: { limit: 1, offset: 0 } }))
        .digest("hex")}`;
      expect(request.arguments).toEqual({ limit: 1, offset: 0 });
      expect(authority).toMatchObject({
        schema_version: 1,
        provider_instance_id: value.context.provider_instance_id,
        workspace_id: value.context.workspace_id,
        principal_id: value.context.principal_id,
        agent_id: value.context.agent_id,
        session_id: value.context.session_id,
        projects: value.context.projects,
        policy_revision: value.context.policy_revision,
        deletion_sequence: value.context.deletion_sequence,
        deletion_set_root: value.context.deletion_set_root,
        signing_key_id: value.context.signing_key_id,
        purpose: "company_memory_read",
        operation: "list_candidates",
        request_digest: expectedDigest,
        nonce: expect.stringMatching(/^jarvis:[0-9a-f-]{36}$/),
      });
      expect(authority).not.toHaveProperty("socket");
      expect(authority).not.toHaveProperty("signing_key_file");
      expect(verify(null, Buffer.from(
        `second-brain/company-memory-authority/v1\0${canonicalize(authority)}`,
      ), value.keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      const issuedAt = Date.parse(String(authority.issued_at));
      expect(Date.parse(String(authority.expires_at)) - issuedAt).toBe(60_000);
      socket.end(JSON.stringify(validResponse()));
    });
    // When: the reader performs its native list operation.
    const result = await createSbCompanyCandidateReader(value.clientPath).read(new AbortController().signal);
    // Then: the signed arguments are bound, and candidate identifiers/content never escape.
    await received;
    expect(result).toEqual({
      state: "read", workspace_id: value.context.workspace_id, candidate_count: 2,
    });
    expect(Object.keys(result).sort()).toEqual(["candidate_count", "state", "workspace_id"]);
  });

  it("returns zero for an empty snapshot", async () => {
    const value = await fixture();
    const responseReceived = receiveRequest(value.server, socket => socket.end(JSON.stringify({
      candidates: [], count: 0, limit: 1, offset: 0,
    })));
    await expect(createSbCompanyCandidateReader(value.clientPath).read(new AbortController().signal))
      .resolves.toEqual({ state: "read", workspace_id: value.context.workspace_id, candidate_count: 0 });
    await responseReceived;
  });

  it("maps native refusal to a safe error without exposing its payload", async () => {
    const value = await fixture();
    const responseReceived = receiveRequest(value.server, socket => socket.end(JSON.stringify({
      error: "COMPANY_KEY_OPERATION_DENIED", detail: "private backend response",
    })));
    await expect(createSbCompanyCandidateReader(value.clientPath).read(new AbortController().signal))
      .rejects.toMatchObject({ code: "SB_COMPANY_CANDIDATE_READ_REFUSED", message: "SB_COMPANY_CANDIDATE_READ_REFUSED" });
    await responseReceived;
  });

  it.each([
    { ...validResponse(), extra: true },
    { ...validResponse(), candidates: [{ ...validResponse().candidates[0], extra: true }] },
    { ...validResponse(), candidates: [], count: 1 },
    { ...validResponse(), count: Number.MAX_SAFE_INTEGER + 1 },
    { ...validResponse(), limit: 2 },
    { ...validResponse(), candidates: [{ ...validResponse().candidates[0], content_digest: "private" }] },
    "{malformed",
  ])("rejects malformed native response %j", async response => {
    const value = await fixture();
    const responseReceived = receiveRequest(value.server, socket => socket.end(
      typeof response === "string" ? response : JSON.stringify(response),
    ));
    await expect(createSbCompanyCandidateReader(value.clientPath).read(new AbortController().signal))
      .rejects.toMatchObject({ code: "SB_COMPANY_CANDIDATE_RESPONSE_INVALID" });
    await responseReceived;
  });

  it("cancels an in-flight socket after observing request admission", async () => {
    // Given: a server that accepts the request but deliberately leaves the response open.
    const value = await fixture();
    const admitted = new Promise<void>(resolve => {
      value.server.once("connection", socket => {
        value.sockets.push(socket);
        socket.once("data", () => resolve());
      });
    });
    const controller = new AbortController();
    // When: cancellation occurs after the subscribed admission event.
    const pending = createSbCompanyCandidateReader(value.clientPath).read(controller.signal);
    await admitted;
    controller.abort();
    // Then: the active request rejects with a safe cancellation code.
    await expect(pending).rejects.toMatchObject({ code: "SB_COMPANY_CANDIDATE_READ_CANCELLED" });
  });

  it("rejects public, symlinked, malformed, and non-Ed25519 credentials", async () => {
    const value = await fixture();
    const publicClient = join(value.root, "public-client.json");
    writeFileSync(publicClient, JSON.stringify(value.context), { mode: 0o644 });
    chmodSync(publicClient, 0o644);
    expect(() => createSbCompanyCandidateReader(publicClient)).toThrow(
      expect.objectContaining({ code: "SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID" }),
    );

    const symlinkClient = join(value.root, "symlink-client.json");
    symlinkSync(value.clientPath, symlinkClient);
    expect(() => createSbCompanyCandidateReader(symlinkClient)).toThrow(
      expect.objectContaining({ code: "SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID" }),
    );

    const malformedClient = join(value.root, "malformed-client.json");
    writeFileSync(malformedClient, JSON.stringify({ ...value.context, workspace_id: "not-a-uuid" }), { mode: 0o600 });
    expect(() => createSbCompanyCandidateReader(malformedClient)).toThrow(
      expect.objectContaining({ code: "SB_COMPANY_CANDIDATE_READER_CONFIG_INVALID" }),
    );

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPath = join(value.root, "rsa-key.pem");
    writeFileSync(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const nonEdClient = join(value.root, "non-ed-client.json");
    writeFileSync(nonEdClient, JSON.stringify({ ...value.context, signing_key_file: rsaPath }), { mode: 0o600 });
    expect(() => createSbCompanyCandidateReader(nonEdClient)).toThrow(
      expect.objectContaining({ code: "SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID" }),
    );
  });
  it.each([
    { purpose: "company_memory_write" }, { operation: "confirm_candidate" },
  ])("rejects a descriptor outside the list-only purpose and operation %j", async override => {
    const value = await fixture();
    writeFileSync(value.clientPath, JSON.stringify({ ...value.context, ...override }), { mode: 0o600 });
    expect(() => createSbCompanyCandidateReader(value.clientPath)).toThrow(
      expect.objectContaining({ code: "SB_COMPANY_CANDIDATE_READER_CONFIG_INVALID" }),
    );
    expect(value.sockets).toHaveLength(0);
  });
});
