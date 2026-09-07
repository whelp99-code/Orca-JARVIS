import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { request as http } from "undici";
import { canonicalize } from "../../src/canonical.js";
import { ControlPlane, signCommandApproval, type StoredControlCommand } from "../../src/control-plane.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { createProductionMemoryOutbox } from "../../src/memory-outbox-production.js";
import { execute } from "../../src/cli-runtime.mjs";
import { startDashboardCli } from "../../src/dashboard/main.js";
import { bindDashboardMemoryDependencies } from "../../src/dashboard/memory-production.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import type { SecondBrainWriteRequestV1 } from "../../src/second-brain-adapter-types.js";
import { outboxFixture, OUTBOX_NOW, FixtureWriter, claimAction } from "../fixtures/memory-outbox-fixture.js";
import { ReconcileHub } from "../../src/dashboard/events.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { localKey } from "../helpers.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function page(request: SecondBrainWriteRequestV1, sequence = 0) {
  const expected = memoryRememberArtifact(request); const text = expected.record_texts[0]!;
  const core = { schema_version: 1, sid: expected.artifact.sid, record_text: text,
    record_text_digest: `sha256:${hash(text)}`, citation_span_start: 0, citation_span_end: Buffer.byteLength(text),
    source_identity_full: expected.source_identity_full, content_identity_full: hash(text),
    citation_identity_full: hash(`${expected.artifact.page_id}\0${expected.artifact.sid}\0${0}:${Buffer.byteLength(text)}`),
    sensitivity: request.sensitivity, source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${hash("owner")}`,
    origin_label: "Second Brain", valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" };
  const digest = hash(`second-brain/memory-record/v1\0${canonicalize(core)}`);
  return { kind: "data" as const, value: { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"a".repeat(64)}`,
    generation_manifest_digest: `sha256:${"b".repeat(64)}`, vault_head: "c".repeat(40), vault_tree: "d".repeat(40),
    tombstone_sequence: sequence, tombstone_set_root: `sha256:${"e".repeat(64)}`,
    frontmatter: { id: expected.artifact.page_id, title: "Memory", compiled_by: "sb/1.0.0|v1|test",
      updated: "2026-08-31", sources: "", status: "active" }, body: text,
    records: [{ ...core, record_id: `sbrecord:v1:${digest}`, record_digest: `sha256:${digest}` }] } };
}
const roots = (root: string) => ({ candidate_review_spool_root: join(root, "candidate-review"),
  candidate_dispatch_spool_root: join(root, "candidate-dispatch") });
const options = { clock: () => OUTBOX_NOW, contract_profile: "schema4" as const,
  max_age_ms: 86_400_000, expiry_ms: 172_800_000,
  budgets: { max_hits: 8, max_excerpt_bytes: 1_024, max_total_bytes: 65_536, max_page_bytes: 1_048_576 } };

describe("production memory outbox composition", () => {
  it("stages digest-only CLI commands idempotently, dispatches once and reconciles on a later invocation", async () => {
    const f = await outboxFixture(); let ready = false; const writes = new FixtureWriter();
    const transport: SecondBrainTransport = { restart: async () => {}, close: vi.fn(async () => {}), diagnostics: () => [],
      call: vi.fn<SecondBrainTransport["call"]>(async (method, args) => method === "sb_write_request"
        ? { kind: "data", value: { schema_version: 1, ...await writes.write(args.request) } }
        : ready ? page(f.request) : { kind: "no_data", reason: "empty_result" }) };
    const deps = { clock: () => OUTBOX_NOW, memoryOutboxOptions: { transport, ...roots(f.database.root) } };
    try {
      const dispatch = new MemoryCandidateDispatchSpool(roots(f.database.root).candidate_dispatch_spool_root).read(f.request.candidate_id);
      f.database.authority.db.prepare(`INSERT INTO memory_candidate_dispatch_publications(
        candidate_id,schema_version,operation,dispatch_spool_digest,state,published_at)
        VALUES(?,1,'remember',?,'published',?)`).run(f.request.candidate_id, dispatch.dispatch_spool_digest, OUTBOX_NOW.toISOString());
      const args = ["memory", "stage-dispatch", f.request.candidate_id, "--db", f.database.path];
      const staged = (await execute(args, deps)).request as StoredControlCommand;
      expect((await execute(args, deps)).request).toEqual(staged);
      expect(canonicalize(staged)).not.toContain(f.request.payload.content);
      new ControlPlane(f.database.authority).decide(signCommandApproval({ schema_version: 1,
        request_id: staged.request_id, receipt_id: "runtime-dispatch", command_digest: staged.command_digest,
        decision: "approve", signer_principal_id: "principal:owner", authenticated_session_id: "owner-session",
        key_id: "decision-test", algorithm: "Ed25519", issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(),
        expires_at: staged.expires_at, nonce: "runtime-dispatch", max_uses: 1, status: "issued" }, localKey(f.database.authority)), OUTBOX_NOW);
      expect(await execute(["control", "execute", staged.request_id, "--db", f.database.path], deps))
        .toMatchObject({ execution: { state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" } });
      ready = true;
      expect(await execute(["memory", "outbox", "--once", "--limit", "1", "--db", f.database.path], deps))
        .toMatchObject({ ok: true, cycle: { dispatched: 0, settled: 1 } });
      expect(await execute(["memory", "outbox", "list", "--db", f.database.path], deps))
        .toMatchObject({ items: [{ state: "settled" }] });
      expect(writes.calls).toHaveLength(1); expect(transport.close).not.toHaveBeenCalled();
    } finally { closeMemoryDatabase(f.database); }
  });

  it("passes a configured nonzero tombstone fence through production completion reads", async () => {
    const f = await outboxFixture();
    const fence = { schema_version: 1 as const, fence_id: `memfence:v1:${"1".repeat(64)}`,
      fence_digest: `sha256:${"1".repeat(64)}`, provider_instance_id: "provider:fixture",
      principal_id: "principal:owner" as const, purpose: "memory_read" as const, operation: "read" as const,
      tombstone_sequence: 2, tombstone_set_root: `sha256:${"e".repeat(64)}`,
      issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(), expires_at: new Date(OUTBOX_NOW.getTime() + 60_000).toISOString(),
      nonce: "nonce:fence", signing_key_id: "jarvis:fixture", signature: "A".repeat(86) };
    const transport: SecondBrainTransport = { call: vi.fn(async () => page(f.request, 2)),
      close: vi.fn(async () => {}), restart: async () => {}, diagnostics: () => [] };
    try {
      const runtime = createProductionMemoryOutbox(f.database.authority, { transport, clock: () => OUTBOX_NOW,
        read_fence: () => fence, ...roots(f.database.root) });
      await expect(runtime.reader.readPage(memoryRememberArtifact(f.request).artifact.page_id)).resolves.toMatchObject({ kind: "current" });
      expect(transport.call).toHaveBeenCalledWith("sb_read_page", expect.objectContaining({ read_fence: fence }));
      await runtime.close(); expect(transport.close).not.toHaveBeenCalled();
      const unfenced = createProductionMemoryOutbox(f.database.authority, { transport, clock: () => OUTBOX_NOW, ...roots(f.database.root) });
      await expect(unfenced.reader.readPage(memoryRememberArtifact(f.request).artifact.page_id)).resolves.toMatchObject({ kind: "invalid" });
    } finally { closeMemoryDatabase(f.database); }
  });

  it("drains an in-flight HTTP dispatch before closing its authority database", async () => {
    const f = await outboxFixture(); const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>(); const writer = new FixtureWriter();
    const transport: SecondBrainTransport = { close: vi.fn(async () => {}), restart: async () => {}, diagnostics: () => [],
      call: async (method, args) => {
        if (method === "sb_write_request") {
          entered.resolve(); await release.promise;
          return { kind: "data", value: { schema_version: 1, ...await writer.write(args.request) } };
        }
        return { kind: "no_data", reason: "empty_result" };
      } };
    writeFileSync(join(f.database.root, "index.html"), "<!doctype html><title>Fixture</title>");
    let origin = "";
    const runtime = startDashboardCli({ host: "127.0.0.1", port: 0, dbPath: f.database.path, staticRoot: f.database.root },
      line => { origin = line; }, undefined, { providerTransport: transport, memoryAdapterOptions: options,
        memoryCandidateReviewSpoolRoot: roots(f.database.root).candidate_review_spool_root,
        memoryCandidateDispatchSpoolRoot: roots(f.database.root).candidate_dispatch_spool_root });
    try {
      const session = await http(`${origin}/api/v1/session`); const body = await session.body.json() as { csrf_token: string };
      const pending = http(`${origin}/api/v1/control/requests/${f.commandId}/execute`, { method: "POST",
        headers: { "X-JARVIS-CSRF": body.csrf_token, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ schema_version: 1 }) }).then(async result => { await result.body.dump(); }, () => {});
      await entered.promise;
      let closed = false; const closing = runtime.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false);
      release.resolve(); await closing; await pending;
      expect(f.database.authority.db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
      expect(f.database.authority.db.prepare("SELECT state,failure_code FROM control_command_requests WHERE request_id=?")
        .get(f.commandId)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
      expect(writer.calls).toHaveLength(1);
      expect(transport.close).not.toHaveBeenCalled();
    } finally { release.resolve(); await runtime.close(); closeMemoryDatabase(f.database); }
  });

  it("keeps an injected read-only adapter from gaining an implicit provider writer", async () => {
    const f = await outboxFixture();
    try {
      const bound = bindDashboardMemoryDependencies(f.database.path, { memoryAdapter: f.reader });
      expect(bound.outboxFor(f.database.authority)).toBeUndefined();
      expect(bound.ownedProviderTransport).toBeUndefined();
    } finally { closeMemoryDatabase(f.database); }
  });

  it("runs queued memory work on the existing dashboard interval and publishes its change", async () => {
    const f = await outboxFixture(); const writer = new FixtureWriter();
    const transport: SecondBrainTransport = { close: async () => {}, restart: async () => {}, diagnostics: () => [],
      call: async (method, args) => method === "sb_write_request"
        ? { kind: "data", value: { schema_version: 1, ...await writer.write(args.request) } }
        : { kind: "no_data", reason: "empty_result" } };
    f.service.enqueue(claimAction(f));
    writeFileSync(join(f.database.root, "index.html"), "<!doctype html><title>Fixture</title>");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const publish = vi.spyOn(ReconcileHub.prototype, "publish");
    const runtime = startDashboardCli({ host: "127.0.0.1", port: 0, dbPath: f.database.path, staticRoot: f.database.root },
      () => {}, undefined, { providerTransport: transport, memoryAdapterOptions: options,
        memoryCandidateReviewSpoolRoot: roots(f.database.root).candidate_review_spool_root,
        memoryCandidateDispatchSpoolRoot: roots(f.database.root).candidate_dispatch_spool_root });
    try {
      expect(writer.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writer.calls).toHaveLength(1);
      expect(publish).toHaveBeenCalledWith(["memory.effects.v1", "memory.records.v1", "memory.candidates.v1"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writer.calls).toHaveLength(1);
    } finally { await runtime.close(); publish.mockRestore(); vi.useRealTimers(); closeMemoryDatabase(f.database); }
  });
});
