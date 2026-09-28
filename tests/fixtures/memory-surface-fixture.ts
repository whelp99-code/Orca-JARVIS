// Task 32 Memory surface fixture: the real dashboard server on an ephemeral loopback port, a
// task-owned migrated authority DB, a fictional in-process schema-4 read adapter, and candidate
// spools. A second loopback control port stands in for the Linux owner (approval receipts) and
// the provider (applying a correction, going offline). Run as
//   node dist/tests/fixtures/memory-surface-fixture.js --static-root dist/dashboard
// It prints one JSON line `{ ready, app, ctl, root, now }` and exits on SIGTERM after removing its root.
// Its clock is anchored at MEMORY_NOW (the candidate fixtures are pinned there) and ticks in real time;
// browsers must install a page clock at `now` so status freshness windows line up.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import type { SecondBrainEvidence, SecondBrainReadAdapter,
  SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";
import { localKey } from "../helpers.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "./memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase } from "./memory-candidate-store.js";

export const MEMORY_FIXTURE_CANARY = "TASK32_FIXTURE_SENSITIVE_CANARY_value";
export const MEMORY_FIXTURE_DELETED = "TASK32_FIXTURE_DELETED_SENTINEL";
export const MEMORY_FIXTURE_ATLAS = "Project Atlas weekly review happens on Monday";
export const MEMORY_FIXTURE_CJK = "기억 표면은 사용자가 통제하는 개인 기억을 다룬다. 아주 긴 한국어 문장이 좁은 화면에서도 잘리지 않고 "
  + "자연스럽게 줄바꿈되어야 하며 식별자 abcdefghijklmnopqrstuvwxyz0123456789 도 넘치지 않아야 한다.";
type ProviderMode = "current" | "offline" | "unavailable" | "no_data" | "stale";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}
const hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function evidence(clock: () => Date, key: string, excerpt: string,
  sensitivity: "personal" | "restricted" = "personal"): SecondBrainEvidence {
  const at = clock().toISOString();
  return { kind: "memory", page_id: `wiki/fixture-${key}`, sid: `fix${hex(key).slice(0, 8)}`,
    source_ref: sensitivity === "restricted" ? "Private source" : "Second Brain",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|fixture",
    sensitivity, observed_at: at, valid_at: at,
    freshness: { state: "fresh", checked_at: at, fresh_until: "2026-09-30T00:00:00.000Z" },
    expires_at: "2026-09-30T00:00:00.000Z", trust: "untrusted", authority: "none", excerpt,
    content_digest: `sha256:${hex(`content:${key}`)}`,
    omission: sensitivity === "restricted" ? "policy_redacted" : null,
    record: { record_id: `sbrecord:v1:${hex(`record:${key}`)}`, record_digest: `sha256:${hex(`digest:${key}`)}`,
      source_identity_full: hex(`source:${key}`), content_identity_full: hex(`cid:${key}`),
      citation_identity_full: hex(`cit:${key}`), source_owner_class: "provider_owned",
      source_owner_id_digest: `sha256:${hex("owner")}`,
      // Adversarial: a path-like label must never reach the DOM.
      origin_label: key === "atlas" ? "Second Brain /vault/secret/atlas.md" : "Second Brain",
      generation: { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${hex("gen")}`,
        generation_manifest_digest: `sha256:${hex("manifest")}`, vault_head: "1".repeat(40),
        vault_tree: "2".repeat(40), tombstone_sequence: 0, tombstone_set_root: `sha256:${"3".repeat(64)}` } } };
}

class FixtureAdapter implements SecondBrainReadAdapter {
  readonly contract_profile = "schema4" as const;
  mode: ProviderMode = "current";
  records: SecondBrainEvidence[];
  constructor(private readonly clock: () => Date) {
    this.records = [
      evidence(clock, "atlas", MEMORY_FIXTURE_ATLAS),
      evidence(clock, "cjk", MEMORY_FIXTURE_CJK),
      evidence(clock, "secret", `${MEMORY_FIXTURE_CANARY} restricted body`, "restricted"),
      evidence(clock, "deleted", `${MEMORY_FIXTURE_DELETED} forgotten body`),
    ];
  }
  private out(records: readonly SecondBrainEvidence[]): SecondBrainReadOutcome {
    const checked_at = this.clock().toISOString();
    switch (this.mode) {
      case "current": return { kind: "current", checked_at, evidence: records };
      case "stale": return { kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", checked_at, evidence: records };
      case "offline": return { kind: "offline", code: "SECOND_BRAIN_OFFLINE", checked_at };
      case "unavailable": return { kind: "unavailable", code: "SECOND_BRAIN_UNAVAILABLE", checked_at };
      case "no_data": return { kind: "no_data", checked_at, fresh_until: "2026-09-30T00:00:00.000Z" };
      default: return assertNever(this.mode);
    }
  }
  search(): Promise<SecondBrainReadOutcome> { return Promise.resolve(this.out(this.records)); }
  readPage(pageId: string): Promise<SecondBrainReadOutcome> {
    return Promise.resolve(this.out(this.records.filter(item => item.page_id === pageId)));
  }
  recentChanges(): Promise<SecondBrainReadOutcome> { return this.search(); }
  openConflicts(): Promise<SecondBrainReadOutcome> {
    const checked_at = this.clock().toISOString();
    if (this.mode !== "current" && this.mode !== "stale") return Promise.resolve(this.out([]));
    const left = this.records.find(item => item.page_id === "wiki/fixture-atlas");
    const right = this.records.find(item => item.page_id === "wiki/fixture-secret");
    return Promise.resolve({ kind: "conflicts", checked_at, conflicts: left !== undefined && right !== undefined
      ? [{ conflict_id: "conflicts/fixture", page_id: left.page_id, state: "unresolved", left, right }] : [] });
  }
  applyCorrection(replacement: string): void {
    this.records = this.records.filter(item => item.page_id !== "wiki/fixture-atlas");
    this.records.unshift(evidence(this.clock, "atlas-v2", replacement));
  }
}
function assertNever(value: never): never { throw new TypeError(`unexpected provider mode: ${String(value)}`); }

async function main(): Promise<void> {
  const staticRoot = argument("static-root");
  if (staticRoot === undefined) throw new Error("missing --static-root");
  const base = Date.parse(MEMORY_NOW); const started = Date.now();
  const clock = (): Date => new Date(base + (Date.now() - started));
  const database = await memoryDatabase();
  const authority = database.authority;
  const reviewRoot = join(database.root, "review"); const dispatchRoot = join(database.root, "dispatch");
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => new Date(base));
  store.attachReviewSpool(reviewRoot);
  store.classify(inferredMemoryInput({ authority_id: "fixture-a", idempotency_key: "candidate:fixture:a",
    subject: "Summary preference", statement: "The owner may prefer concise technical summaries." }));
  store.classify(inferredMemoryInput({ authority_id: "fixture-b", idempotency_key: "candidate:fixture:b",
    subject: "한국어 후보", statement: `${MEMORY_FIXTURE_CJK} 후보 문장.` }));
  const adapter = new FixtureAdapter(clock);
  const server = createDashboardServer({ db: authority, staticRoot, host: "127.0.0.1", port: 0, clock,
    memoryAdapter: adapter, memoryProjectionKey: Buffer.alloc(32, 9),
    memoryEffectSpoolRoot: join(database.root, "effects"),
    memoryCandidateReviewSpoolRoot: reviewRoot, memoryCandidateDispatchSpoolRoot: dispatchRoot });
  const control = new ControlPlane(authority);
  function decide(decision: "approve" | "reject"): string[] {
    const decided: string[] = [];
    for (const command of control.list().filter(row => row.state === "pending")) {
      const now = clock();
      control.decide(signCommandApproval({ schema_version: 1, receipt_id: `fixture-${decision}-${command.request_id}`,
        request_id: command.request_id, decision, command_digest: command.command_digest,
        signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
        algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
        expires_at: command.expires_at, nonce: `fixture-nonce-${command.request_id}`, max_uses: 1, status: "issued" },
      localKey(authority)), now);
      decided.push(`${command.action}:${command.request_id}`);
    }
    return decided;
  }
  const state = () => {
    const all = (sql: string) => authority.db.prepare(sql).all();
    return { commands: all("SELECT action,state,COUNT(*) AS n FROM control_command_requests GROUP BY action,state"),
      attempts: all("SELECT state,COUNT(*) AS n FROM memory_surface_effect_attempts GROUP BY state"),
      suppressions: all("SELECT operation,COUNT(*) AS n FROM memory_surface_suppressions GROUP BY operation"),
      authority: all("SELECT privacy_epoch,suppression_sequence FROM memory_surface_authority") };
  };
  const ctl = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body: unknown = {};
    try {
      switch (url.pathname) {
        case "/state": body = state(); break;
        case "/now": body = { now: clock().toISOString() }; break;
        case "/mode": {
          const mode = url.searchParams.get("value");
          if (mode !== "current" && mode !== "offline" && mode !== "unavailable" && mode !== "no_data" && mode !== "stale") {
            response.statusCode = 400; break;
          }
          adapter.mode = mode; body = { mode }; break;
        }
        case "/approve": body = { decided: decide("approve") }; break;
        case "/reject": body = { decided: decide("reject") }; break;
        case "/provider-apply-correction":
          adapter.applyCorrection(url.searchParams.get("text") ?? "corrected"); body = { applied: true }; break;
        case "/list": body = control.list().map(row => ({ id: row.request_id, action: row.action, state: row.state })); break;
        default: response.statusCode = 404;
      }
    } catch (error) { response.statusCode = 500; body = { error: String(error) }; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => { ctl.listen(0, "127.0.0.1", resolve); });
  const ctlAddress = ctl.address();
  if (ctlAddress === null || typeof ctlAddress === "string") throw new Error("control port");
  process.stdout.write(`${JSON.stringify({ ready: true, app: `http://127.0.0.1:${String(server.address.port)}`,
    ctl: `http://127.0.0.1:${String(ctlAddress.port)}`, root: database.root, now: clock().toISOString() })}\n`);
  const shutdown = (): void => {
    server.close(); ctl.close(); closeMemoryDatabase(database);
    process.stdout.write(`${JSON.stringify({ cleanup: "closed-and-removed", root: database.root })}\n`);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && /memory-surface-fixture\.[cm]?js$/u.test(entry)) {
  main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
}
