import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  JARVIS_MCP_MAX_FRAME_BYTES,
  handleJarvisMcpRequest,
  openJarvisAgentMcp,
  runJarvisAgentMcp,
} from "../../src/agent-mcp-server.js";
import { AuthorityDb } from "../../src/db.js";
import { DailyControlRuntime } from "../../src/daily-control-runtime.js";
import { MemoryCandidateClassifier } from "../../src/memory-candidates.js";
import { MemoryOutbox, UNBOUND_ARTIFACT_DIGEST } from "../../src/memory-outbox.js";
import {
  MemorySettlementService,
  SecondBrainProviderClient,
  type SecondBrainProvider,
} from "../../src/second-brain-provider.js";
import type { TerminalWorkSummaryV1 } from "../../src/second-brain-write-request.js";
import { createSecondBrainProviderReadinessProbe } from "../../src/second-brain-provider-readiness.js";
import { ShellFallbackCollector } from "../../src/shell-fallback.js";
import { TerminalWorkMemory } from "../../src/terminal-work-memory.js";
import { tempDb } from "../helpers.js";

const T0 = "2026-08-30T00:00:00.000Z";
const T1 = "2026-08-30T00:01:00.000Z";
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
const RECEIPT_DIGEST = `sha256:${"b".repeat(64)}`;
const PAGE_ID = "terminal-work/candidate-child";

async function dbFixture(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  await db.assertMigrationsReady();
  return db;
}

function summary(
  candidateId = "candidate:child",
  closeoutId = "closeout:child",
  receiptDigest = RECEIPT_DIGEST,
): TerminalWorkSummaryV1 {
  return {
    schema: "terminal-work-summary-v1",
    memory_candidate_id: candidateId,
    jarvis_closeout_id: closeoutId,
    jarvis_receipt_digest: receiptDigest,
    project_id: "project:test",
    host_scope: ["jm-cloud"],
    terminal_count: 1,
    started_at: T0,
    finished_at: T1,
    outcome: "success",
    verified: true,
    purpose: "runtime interoperability",
    work_performed: ["implemented runtime wiring"],
    verified_results: ["verification:test"],
    failures: [],
    artifacts: ["artifact:test"],
    commits: [],
    issues: [],
    improvements: [],
    next_actions: [],
    source_refs: ["source:test"],
  };
}

function exactWriteRequest(
  requestId = "outbox:child",
  candidateId = "candidate:child",
  closeoutId = "closeout:child",
  receiptDigest = RECEIPT_DIGEST,
): Record<string, unknown> {
  return {
    schema: "second-brain-write-request-v1",
    operation: "remember",
    candidate_id: candidateId,
    closeout_id: closeoutId,
    receipt_digest: receiptDigest,
    purpose: "runtime interoperability",
    sensitivity: "normal",
    retention: "durable",
    expected_prior_digest: null,
    idempotency_key: `idem:${requestId}`,
    summary: summary(candidateId, closeoutId, receiptDigest),
    request_id: requestId,
  };
}

function seedVerifiedCloseout(db: AuthorityDb): string {
  const memory = new TerminalWorkMemory(db.db);
  memory.startSession({
    terminal_id: "terminal:settlement",
    terminal_incarnation_id: "inc:settlement",
    host_id: "host:pos:linux-control-plane",
    environment_id: "jm-cloud",
    terminal_provider: "orca",
    started_at: T0,
    primary_project_id: "project:test",
    created_by: "owner",
    correlation_id: "corr:session:settlement",
  });
  return memory.finishWork({
    closeout_id: "closeout:settlement",
    work_id: "work:settlement",
    correlation_id: "corr:settlement",
    terminal_ids: ["terminal:settlement"],
    project_ids: ["project:test"],
    outcome: "success",
    verified_result: ["verification:settlement"],
    failed_items: [],
    unresolved_items: [],
    artifacts: ["artifact:settlement"],
    commit_refs: [],
    issue_refs: [],
    improvements: [],
    next_actions: [],
    signed_at: T1,
  }).canonical_digest;
}

describe("joint runtime wiring", () => {
  it("serves MCP initialize, ping, and all bounded agent tools", async () => {
    const runtime = await openJarvisAgentMcp(tempDb());
    try {
      const initialize = handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      expect(initialize?.result).toMatchObject({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "jarvis-agent-bridge" },
      });
      const listed = handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      const tools = (listed?.result as {
        tools: Array<{ name: string; inputSchema: { additionalProperties: boolean } }>;
      }).tools;
      expect(tools).toHaveLength(9);
      expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
      expect(handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 3,
        method: "ping",
      })).toMatchObject({ result: {} });
      const read = handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "jarvis_unresolved_failures", arguments: {} },
      });
      expect(read?.result).toMatchObject({
        isError: false,
        structuredContent: { value: [] },
      });
      const content = (read?.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0]?.text ?? "")).toEqual([]);
      const write = handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "jarvis_checkpoint",
          arguments: {
            checkpoint_id: "checkpoint:mcp",
            correlation_id: "corr:mcp",
            purpose: "mcp interoperability",
            decision: "write path",
            created_at: T0,
          },
        },
      });
      expect(write?.result).toMatchObject({
        isError: false,
        structuredContent: { accepted: true },
      });
      expect(handleJarvisMcpRequest(runtime.bridge, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "missing", arguments: {} },
      })).toMatchObject({ result: { isError: true } });
    } finally {
      runtime.db.close();
    }
  });

  it("rejects malformed and oversized stdio frames", async () => {
    const output: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    await runJarvisAgentMcp({
      dbPath: tempDb(),
      input: Readable.from([
        Buffer.from(`not-json\n${"x".repeat(JARVIS_MCP_MAX_FRAME_BYTES + 1)}\n`, "utf8"),
      ]),
      output: sink,
    });
    const responses = Buffer.concat(output).toString("utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(responses.map((item) => item.error.code)).toEqual([-32700, -32600]);
  });

  it("rejects ORCA and secret-shaped shell fallback events", async () => {
    const db = await dbFixture();
    try {
      const collector = new ShellFallbackCollector(db.db);
      const base = {
        event_id: "event:test",
        terminal_id: "terminal:test",
        terminal_incarnation_id: "inc:test",
        sequence: 1,
        kind: "command" as const,
        occurred_at: T0,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        exit_code: 0,
        outcome: "succeeded" as const,
        command_class: "git",
        command_digest: "sha256:a",
        evidence_ref: null,
        correlation_id: "corr:test",
        collector_id: "collector:test",
        cwd_digest: "sha256:b",
      };
      expect(() => collector.ingest({
        ...base,
        stdout: undefined,
        stderr: undefined,
        orca_available: true,
      } as never)).toThrow("SHELL_FALLBACK_NOT_REQUIRED");
      expect(() => collector.ingest({
        ...base,
        stdout: "password=x",
        stderr: undefined,
        orca_available: false,
      })).toThrow("SHELL_FALLBACK_REDACTION_REQUIRED");
    } finally {
      db.close();
    }
  });

  it("runs morning control once with honest unavailable refresh", async () => {
    const db = await dbFixture();
    try {
      const readiness = createSecondBrainProviderReadinessProbe({
        open: () => ({
          health: async () => ({
            kind: "health",
            status: "ok",
            contract: "second-brain-provider-v1",
            version: "1",
            capabilities: ["approved_write_requests"],
            detail: "fixture",
            writable: true,
          }),
          close: async () => undefined,
        }),
      });
      const runtime = new DailyControlRuntime({
        db,
        readiness,
        clock: () => new Date("2026-08-30T00:30:00.000Z"),
      });
      const status = await runtime.once();
      expect(status.loop_date).toBe("2026-08-30");
      expect(status.completed).toContain("morning");
      expect(status.degraded).toBe(true);
      expect(status.readiness).toMatchObject({ readiness: "degraded" });
      expect((await runtime.once()).completed).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("settles only after exact provider artifact observation without restore", async () => {
    const db = await dbFixture();
    let writePayload: Record<string, unknown> | undefined;
    let observed: readonly unknown[] | undefined;
    let restores = 0;
    const provider: SecondBrainProvider = {
      health: async () => ({
        kind: "health",
        status: "ok",
        contract: "second-brain-provider-v1",
        version: "1",
        capabilities: ["approved_write_requests"],
        detail: "fixture",
        writable: true,
      }),
      writeRequest: async (value) => {
        writePayload = value;
        return {
          request_id: String(value.request_id),
          status: "applied",
          idempotent_replay: false,
          artifact_digest: ARTIFACT_DIGEST,
          page_id: PAGE_ID,
          result: {},
        };
      },
      requestStatus: async (requestId) => ({
        kind: "request",
        found: true,
        request_id: requestId,
        status: "applied",
        artifact_digest: ARTIFACT_DIGEST,
        page_id: PAGE_ID,
        result: {},
        history: [],
      }),
      reconcileWrite: async (requestId) => ({
        request_id: requestId,
        status: "applied",
        idempotent_replay: true,
        artifact_digest: ARTIFACT_DIGEST,
        page_id: PAGE_ID,
        result: {},
      }),
      restoreRequest: async (requestId) => {
        restores += 1;
        return {
          request_id: requestId,
          status: "restored",
          idempotent_replay: false,
          artifact_digest: ARTIFACT_DIGEST,
          page_id: PAGE_ID,
          result: {},
        };
      },
      observeArtifact: async (requestId, digest, pageId) => {
        observed = [requestId, digest, pageId];
        return {
          request_id: requestId,
          status: "settled",
          idempotent_replay: false,
          artifact_digest: digest,
          page_id: pageId,
          result: { observed: true },
        };
      },
      exportHistory: async () => ({}),
    };
    try {
      const receiptDigest = seedVerifiedCloseout(db);
      const candidate = new MemoryCandidateClassifier(db.db).classify({
        candidate_id: "candidate:settlement",
        correlation_id: "corr:settlement",
        idempotency_key: "idem:candidate",
        origin: "explicit_user",
        operation: "remember",
        content: "verified fact",
        source_refs: ["source:test"],
        sensitivity: "normal",
        confidence: "verified",
        purpose: "personal_memory",
        expires_at: "2026-09-01T00:00:00.000Z",
        now: T0,
      });
      const queued = new MemoryOutbox(db.db).queue({
        outbox_id: "outbox:settlement",
        candidate_id: candidate.candidate_id,
        idempotency_key: "idem:outbox",
        operation: "remember",
        expected_artifact_selector: PAGE_ID,
        expected_artifact_digest: ARTIFACT_DIGEST,
        provider_version: "fixture",
        expires_at: "2026-09-01T00:00:00.000Z",
        now: T0,
      });
      const settled = await new MemorySettlementService({
        source: db.db,
        provider,
        owner: "worker:test",
        clock: () => new Date(T1),
      }).settle(queued.outbox_id);
      expect(settled.state).toBe("settled");
      expect(restores).toBe(0);
      expect(observed).toEqual([
        "outbox:settlement",
        ARTIFACT_DIGEST,
        PAGE_ID,
      ]);
      expect(writePayload).toMatchObject({
        schema: "second-brain-write-request-v1",
        request_id: "outbox:settlement",
        candidate_id: "candidate:settlement",
        closeout_id: "closeout:settlement",
        receipt_digest: receiptDigest,
        idempotency_key: "idem:outbox",
        retention: "durable",
        expected_prior_digest: null,
        summary: {
          schema: "terminal-work-summary-v1",
          memory_candidate_id: "candidate:settlement",
          jarvis_closeout_id: "closeout:settlement",
          jarvis_receipt_digest: receiptDigest,
          verified: true,
        },
      });
      expect(writePayload).not.toHaveProperty("contract");
      expect(writePayload).not.toHaveProperty("expected_artifact_digest");
    } finally {
      db.close();
    }
  });

  it("speaks the exact provider profile in a child process", async () => {
    const client = new SecondBrainProviderClient({
      launcherPath: join(process.cwd(), "tests/fixtures/provider-mcp-child.mjs"),
      launcherArgs: [],
      configPath: "/tmp/provider-fixture.toml",
    });
    try {
      await expect(client.health()).resolves.toMatchObject({
        kind: "health",
        status: "ok",
        contract: "second-brain-provider-v1",
        version: "1",
        writable: true,
      });
      await expect(client.writeRequest(exactWriteRequest())).resolves.toMatchObject({
        status: "applied",
        request_id: "outbox:child",
        artifact_digest: ARTIFACT_DIGEST,
        page_id: PAGE_ID,
      });
      await expect(client.requestStatus("outbox:child")).resolves.toMatchObject({
        kind: "request",
        found: true,
        status: "applied",
        request_id: "outbox:child",
      });
      await expect(client.observeArtifact(
        "outbox:child",
        ARTIFACT_DIGEST,
        PAGE_ID,
      )).resolves.toMatchObject({
        status: "settled",
        request_id: "outbox:child",
      });
    } finally {
      await client.close();
    }
  });
});

const realProviderBin = process.env.SECOND_BRAIN_REAL_PROVIDER_BIN;
const realProviderIt = realProviderBin && existsSync(realProviderBin) ? it : it.skip;

realProviderIt("integrates with the actual Second Brain provider process", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-real-provider-"));
  const config = join(root, "config.toml");
  const vault = join(root, "vault");
  writeFileSync(config, [
    `vault_root = ${JSON.stringify(vault)}`,
    "[filesystem]",
    'mode = "trusted-root"',
    "[search]",
    "hybrid = false",
    "",
  ].join("\n"), { mode: 0o600 });
  execFileSync(realProviderBin as string, ["init"], {
    env: { ...process.env, SB_CONFIG: config },
    stdio: "pipe",
  });
  const client = new SecondBrainProviderClient({
    launcherPath: realProviderBin,
    launcherArgs: ["mcp"],
    configPath: config,
  });
  try {
    const health = await client.health();
    expect(health).toMatchObject({
      kind: "health",
      status: "ok",
      contract: "second-brain-provider-v1",
      version: "1",
      writable: true,
    });
    const request = exactWriteRequest(
      "outbox:actual",
      "candidate:actual",
      "closeout:actual",
    );
    const applied = await client.writeRequest(request);
    expect(applied).toMatchObject({
      request_id: "outbox:actual",
      status: "applied",
      artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      page_id: expect.any(String),
    });
    const status = await client.requestStatus(applied.request_id);
    expect(status).toMatchObject({
      kind: "request",
      found: true,
      status: "applied",
      artifact_digest: applied.artifact_digest,
      page_id: applied.page_id,
    });
    const settled = await client.observeArtifact(
      applied.request_id,
      applied.artifact_digest as string,
      applied.page_id,
    );
    expect(settled).toMatchObject({
      request_id: applied.request_id,
      status: "settled",
      artifact_digest: applied.artifact_digest,
      page_id: applied.page_id,
    });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

realProviderIt("settles a JARVIS outbox against the actual provider without predicting its artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-real-outbox-"));
  const config = join(root, "config.toml");
  const vault = join(root, "vault");
  writeFileSync(config, [
    `vault_root = ${JSON.stringify(vault)}`,
    "[filesystem]",
    'mode = "trusted-root"',
    "[search]",
    "hybrid = false",
    "",
  ].join("\n"), { mode: 0o600 });
  execFileSync(realProviderBin as string, ["init"], {
    env: { ...process.env, SB_CONFIG: config },
    stdio: "pipe",
  });
  const db = await dbFixture();
  const client = new SecondBrainProviderClient({
    launcherPath: realProviderBin,
    launcherArgs: ["mcp"],
    configPath: config,
  });
  try {
    seedVerifiedCloseout(db);
    const candidate = new MemoryCandidateClassifier(db.db).classify({
      candidate_id: "candidate:actual-settlement",
      correlation_id: "corr:settlement",
      idempotency_key: "idem:candidate:actual-settlement",
      origin: "explicit_user",
      operation: "remember",
      content: "verified real provider settlement",
      source_refs: ["source:actual-settlement"],
      sensitivity: "normal",
      confidence: "verified",
      purpose: "real_provider_settlement",
      expires_at: "2026-09-01T00:00:00.000Z",
      now: T0,
    });
    const queued = new MemoryOutbox(db.db).queue({
      outbox_id: "outbox:actual-settlement",
      candidate_id: candidate.candidate_id,
      idempotency_key: "idem:outbox:actual-settlement",
      operation: "remember",
      provider_version: "second-brain-provider-v1",
      expires_at: "2026-09-01T00:00:00.000Z",
      now: T0,
    });
    expect(queued).toMatchObject({
      state: "queued",
      expected_artifact_digest: UNBOUND_ARTIFACT_DIGEST,
      provider_artifact_digest: null,
      provider_page_id: null,
    });
    const settled = await new MemorySettlementService({
      source: db.db,
      provider: client,
      owner: "worker:actual-settlement",
      clock: () => new Date(T1),
    }).settle(queued.outbox_id);
    expect(settled).toMatchObject({
      state: "settled",
      provider_status: "applied",
      provider_artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      provider_page_id: expect.stringMatching(/^terminal-work\//u),
    });
    expect(settled.provider_artifact_digest).not.toBe(UNBOUND_ARTIFACT_DIGEST);
    const page = await client.call("sb_read_page", {
      id: settled.provider_page_id as string,
    });
    expect(page).toMatchObject({
      frontmatter: { status: "active" },
      body: expect.stringContaining("real_provider_settlement"),
    });
    expect(db.db.prepare(
      "SELECT event_type,observed_artifact_digest FROM memory_reconciliation_events "
      + "WHERE outbox_id=?",
    ).get(queued.outbox_id)).toEqual({
      event_type: "artifact_observed",
      observed_artifact_digest: settled.provider_artifact_digest,
    });
  } finally {
    await client.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
