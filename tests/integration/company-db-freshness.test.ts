import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { companyCheckpointSchema } from "../../src/company-freshness.js";
import { loadCompanyFreshnessClient } from "../../src/company-freshness-client-config.js";
import { signCompanyFreshnessEnvelope } from "../../src/company-freshness-envelope.js";
import { signCompanyInternalEnvelope } from "../../src/company-internal-envelope.js";
import { companyFreshnessBroker } from "../fixtures/company-freshness-broker.js";

const clientWorker = fileURLToPath(new URL("../../dist/tests/fixtures/company-freshness-client-call.mjs", import.meta.url));
const transportWorker = fileURLToPath(new URL("../../dist/src/company-freshness-transport-main.mjs", import.meta.url));

function readRequest(fixture: Awaited<ReturnType<typeof companyFreshnessBroker>>) {
  return { schema_version: 2 as const, scope: fixture.fixture.test_only_memory.factory_input.scope,
    installation_id: "installation:jarvis", challenge: "challenge:broker-read",
    observed_checkpoint: companyCheckpointSchema.parse(fixture.fixture.test_only_memory.factory_input.initial_checkpoint) };
}

function call(config: string, method: string, request: unknown): unknown {
  return JSON.parse(execFileSync(process.execPath, [clientWorker, config, method], {
    input: canonicalize(request), encoding: "utf8", timeout: 15_000,
  }));
}

async function rawCall(socketPath: string, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Broker response timeout")); }, 5_000);
    const chunks: Buffer[] = [];
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("connect", () => socket.end(canonicalize(input)));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

describe("company database freshness signed broker transport", () => {
  it.each(["auto", "report"] as const)("pins the signed %s route to its dedicated existing broker config", async route => {
    const live = await companyFreshnessBroker({ route });
    try {
      const operation = route === "auto" ? "auto_process_internal" : "read_auto_report";
      const args = route === "auto" ? { limit: 100 }
        : { from_global_sequence: 0, to_global_sequence: 100, limit: 100, cursor: null };
      const response = JSON.parse(execFileSync(process.execPath, [transportWorker, "--config", live.client], {
        input: canonicalize({ schema_version: 1, operation, arguments: args }), encoding: "utf8", timeout: 15_000,
      }));
      expect(response).toEqual({ TEST_ONLY: true, action: route === "auto" ? "auto-internal" : "auto-report" });
      expect(live.captured()).toMatchObject({
        argv: [route === "auto" ? "auto-internal" : "auto-report", "--config", live.freshnessConfig],
        envelope: { arguments: args, authority: { operation,
          purpose: route === "auto" ? "company_internal_auto_trigger" : "company_memory_auto_report" } },
      });
      const signed = signCompanyInternalEnvelope({ schema_version: 1, operation, arguments: args }, loadCompanyFreshnessClient(live.client));
      expect(await rawCall(live.socket, { ...signed, authority: { ...signed.authority, purpose: "policy_auto" } }))
        .toBe('{"error":"COMPANY_CANDIDATE_BROKER_REFUSED"}');
      expect(await rawCall(live.socket, { ...signed, arguments: { ...args, limit: 101, config: "/forbidden/override" } }))
        .toBe('{"error":"COMPANY_CANDIDATE_BROKER_REFUSED"}');
    } finally { await live.close(); }
  });

  it("uses the synchronous helper and signed freshness-only argv without inherited overrides", async () => {
    const live = await companyFreshnessBroker({ installationId: "installation:actual-registry" });
    try {
      const request = readRequest(live);
      const response = call(live.client, "read_freshness", request);
      const capture = live.captured();
      expect(capture).toMatchObject({
        argv: ["freshness", "--config", live.freshnessConfig],
        env: { PATH: "/usr/bin:/bin" },
        envelope: { schema_version: 1, method: "read_freshness", evidence: null,
          request: { installation_id: "installation:actual-registry" },
          authority: { principal_id: "principal:jarvis-company-progress", purpose: "company_freshness_progress" } },
      });
      expect(response).toEqual({
        schema_version: 2, scope: request.scope, challenge: request.challenge, status: "ready", checkpoint: request.observed_checkpoint,
      });
      expect(JSON.stringify(capture)).not.toContain("/forbidden/");
    } finally { await live.close(); }
  });

  it("refuses freshness when the fixed processor config did not enable its route", async () => {
    const live = await companyFreshnessBroker({ enabled: false });
    try {
      expect(call(live.client, "read_freshness", readRequest(live))).toMatchObject({ status: "unavailable", checkpoint: null });
      expect(live.captured()).toBeNull();
    } finally { await live.close(); }
  });

  it("rejects purpose substitution before spawning the pinned SB executable", async () => {
    const live = await companyFreshnessBroker();
    try {
      const envelope = signCompanyFreshnessEnvelope({
        schema_version: 1, method: "read_freshness", request: readRequest(live), evidence: null,
      }, loadCompanyFreshnessClient(live.client));
      expect(await rawCall(live.socket, { ...envelope,
        authority: { ...envelope.authority, purpose: "company_memory_accept" } }))
        .toBe('{"error":"COMPANY_CANDIDATE_BROKER_REFUSED"}');
      expect(live.captured()).toBeNull();
    } finally { await live.close(); }
  });

  it("does not let JARVIS reserve a step owned by SB", async () => {
    const live = await companyFreshnessBroker();
    try {
      const read = readRequest(live);
      expect(call(live.client, "reserve_progress", { schema_version: 2, scope: read.scope,
        operation_id: `sha256:${"a".repeat(64)}`, operation: "accept", expected_checkpoint: read.observed_checkpoint,
        event_digest: `sha256:${"b".repeat(64)}`, challenge: "challenge:reserve" }))
        .toEqual({ schema_version: 2, outcome: "error", code: "COMPANY_FRESHNESS_REQUIRED" });
      expect(live.captured()).toBeNull();
    } finally { await live.close(); }
  });

  it("closes the wire on an oversized SB response rather than returning success", async () => {
    const live = await companyFreshnessBroker({ oversized: true });
    try {
      expect(call(live.client, "read_freshness", readRequest(live))).toMatchObject({ status: "unavailable", checkpoint: null });
    } finally { await live.close(); }
  });
});
