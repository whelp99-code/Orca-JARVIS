import { describe, expect, it } from "vitest";
import {
	JarvisAgentBridge,
	MemoryCandidateClassifier,
	MemoryOutbox,
	PhoneGatewayPolicy,
	TerminalWorkMemory,
	WorkflowCorrelationStore,
} from "../../src/index.js";
import { closePersonalDb, personalDb } from "./personal-operations-test-helpers.js";

const T0 = "2026-08-29T00:00:00.000Z";
const T1 = "2026-08-29T00:01:00.000Z";
const T2 = "2026-08-29T00:02:00.000Z";
const T3 = "2026-08-29T00:03:00.000Z";
const T4 = "2026-08-29T00:04:00.000Z";
const session = {
	terminal_id: "terminal:test",
	terminal_incarnation_id: "incarnation:test",
	host_id: "host:pos:linux-control-plane" as const,
	environment_id: "env:test",
	terminal_provider: "orca",
	started_at: T0,
	created_by: "owner",
	correlation_id: "corr:session",
};

describe("JARVIS joint contracts", () => {
	it("records digest-only terminal evidence and requires verified closeout evidence", async () => {
		const db = await personalDb();
		try {
			const memory = new TerminalWorkMemory(db.db);
			expect(memory.startSession(session).status).toBe("active");
			expect(memory.startSession(session).terminal_id).toBe(session.terminal_id);
			const event = memory.recordEvent({
				event_id: "event:test",
				...session,
				sequence: 1,
				kind: "test",
				occurred_at: T1,
				outcome: "failed",
				command_class: "test",
				command: "npm test",
				stdout: "password: do-not-store",
				correlation_id: "corr:event",
			});
			expect(event.redaction_state).toBe("digest_only");
			expect(event.stdout_digest).toMatch(/^sha256:/);
			expect(db.db.prepare("SELECT stdout_digest,redaction_state FROM terminal_events WHERE event_id=?").get(event.event_id)).toEqual(
				expect.objectContaining({ redaction_state: "digest_only" }),
			);
			memory.openFailure({
				failure_id: "failure:test",
				terminal_id: session.terminal_id,
				terminal_incarnation_id: session.terminal_incarnation_id,
				source_event_id: event.event_id,
				failure_class: "test",
				summary: "A test failed",
				severity: "P1",
			});
			expect(() =>
				memory.finishWork({
					closeout_id: "closeout:bad",
					work_id: "work:test",
					correlation_id: "corr:closeout-bad",
					terminal_ids: [session.terminal_id],
					project_ids: [],
					outcome: "success",
					verified_result: [],
					failed_items: [],
					unresolved_items: [],
					artifacts: [],
					commit_refs: [],
					issue_refs: [],
					improvements: [],
					next_actions: [],
					signed_at: T2,
				}),
			).toThrow("TERMINAL_COMPLETION_EVIDENCE_REQUIRED");
			memory.resolveFailure({
				resolution_id: "resolution:test",
				failure_id: "failure:test",
				source_event_ids: [event.event_id],
				summary: "Fixed by correction",
				verification_id: "verification:test",
				verified_at: T3,
				correlation_id: "corr:resolution",
			});
			expect(
				memory.finishWork({
					closeout_id: "closeout:ok",
					work_id: "work:test",
					correlation_id: "corr:closeout",
					terminal_ids: [session.terminal_id],
					project_ids: [],
					outcome: "success",
					verified_result: ["verification:test"],
					failed_items: [],
					unresolved_items: [],
					artifacts: ["artifact:test"],
					commit_refs: [],
					issue_refs: [],
					improvements: [],
					next_actions: [],
					signed_at: T4,
				}).outcome,
			).toBe("success");
		} finally {
			closePersonalDb(db);
		}
	});

	it("classifies safe memory candidates and settles outbox only after artifact reconciliation", async () => {
		const db = await personalDb();
		try {
			const classifier = new MemoryCandidateClassifier(db.db);
			const candidate = classifier.classify({
				candidate_id: "candidate:test",
				correlation_id: "corr:candidate",
				idempotency_key: "idem:candidate",
				origin: "verified_outcome",
				operation: "remember",
				content: "Verified outcome",
				source_refs: ["event:test"],
				sensitivity: "normal",
				confidence: "verified",
				purpose: "future retrieval",
				expires_at: "2026-08-30T00:00:00.000Z",
				now: T0,
			});
			expect(candidate.state).toBe("classified");
			const outbox = new MemoryOutbox(db.db);
			const artifactDigest = `sha256:${"a".repeat(64)}`;
			const queued = outbox.queue({
				outbox_id: "outbox:test",
				candidate_id: candidate.candidate_id,
				idempotency_key: "idem:outbox",
				operation: "remember",
				expected_artifact_selector: "memory:test",
				expected_artifact_digest: artifactDigest,
				provider_version: "second-brain:v1",
				expires_at: "2026-08-30T00:00:00.000Z",
				now: T0,
			});
			const claimed = outbox.claim(queued.outbox_id, "writer", T1, 180_000);
			const accepted = await outbox.deliver(
				claimed.outbox_id,
				"writer",
				claimed.lease_fence,
				async () => ({
					outcome: "accepted",
					artifact_digest: artifactDigest,
					page_id: "memory:test",
					provider_status: "applied",
				}),
				T2,
			);
			expect(accepted).toMatchObject({
				state: "accepted_unsettled",
				provider_artifact_digest: artifactDigest,
				provider_page_id: "memory:test",
				provider_status: "applied",
			});
			expect(outbox.reconcile(
				accepted.outbox_id,
				accepted.lease_fence,
				artifactDigest,
				T3,
			).state).toBe("settled");
			expect(db.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?").get(candidate.candidate_id)).toEqual({
				state: "settled",
			});
			expect(
				classifier.classify({
					candidate_id: "candidate:rejected",
					correlation_id: "corr:rejected",
					idempotency_key: "idem:rejected",
					origin: "raw_transcript",
					operation: "remember",
					content: "raw",
					source_refs: ["event:test"],
					sensitivity: "normal",
					confidence: "verified",
					purpose: "reject",
					expires_at: "2026-08-30T00:00:00.000Z",
					now: T0,
				}).state,
			).toBe("rejected");
		} finally {
			closePersonalDb(db);
		}
	});

	it("keeps workflow correlation links and event payloads digest-only", async () => {
		const db = await personalDb();
		try {
			const store = new WorkflowCorrelationStore(db.db);
			const linked = store.link({
				correlation_id: "corr:workflow",
				project_id: "project:test",
				work_id: "work:test",
				task_id: "task:test",
				terminal_id: "terminal:test",
				terminal_incarnation_id: "incarnation:test",
				created_at: T0,
			});
			expect(
				store.link({
					correlation_id: linked.correlation_id,
					project_id: "project:test",
					work_id: "work:test",
					task_id: "task:test",
					terminal_id: "terminal:test",
					terminal_incarnation_id: "incarnation:test",
					created_at: T0,
				}).correlation_id,
			).toBe(linked.correlation_id);
			store.append({
				event_id: "corr-event:test",
				correlation_id: linked.correlation_id,
				kind: "verification",
				idempotency_key: "idem:corr-event",
				payload: { status: "verified" },
				evidence_digest: "sha256:evidence",
				created_at: T1,
			});
			expect(
				db.db.prepare("SELECT payload_digest,evidence_digest FROM workflow_correlation_events WHERE event_id=?").get("corr-event:test"),
			).toEqual(expect.objectContaining({ payload_digest: expect.stringMatching(/^sha256:/), evidence_digest: "sha256:evidence" }));
		} finally {
			closePersonalDb(db);
		}
	});
	it("exposes bridge tools and restricts phone access to the approved read boundary", async () => {
		const policy = new PhoneGatewayPolicy("jarvis.example.ts.net", "owner@example.com");
		expect(
			policy.authorize({
				peer_address: "127.0.0.1",
				host: "jarvis.example.ts.net",
				origin: "https://jarvis.example.ts.net",
				path: "/api/v1/today",
				tailscale_user_login: "owner@example.com",
			}).code,
		).toBe("OK");
		expect(
			policy.authorize({
				peer_address: "10.0.0.2",
				host: "jarvis.example.ts.net",
				origin: "https://jarvis.example.ts.net",
				path: "/api/v1/today",
				tailscale_user_login: "owner@example.com",
			}).code,
		).toBe("GATEWAY_PEER_DENIED");
		const db = await personalDb();
		try {
			const memory = new TerminalWorkMemory(db.db);
			memory.startSession(session);
			const bridge = new JarvisAgentBridge(memory);
			expect(bridge.tools()).toContain("jarvis_finish_work");
			expect(bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toContain('"tools"');
			expect(bridge.handle({ id: 2, method: "tools/call", params: { name: "jarvis_decision_queue", arguments: {} } }).result).toEqual({
				decisions: [],
				source: "authority",
			});
		} finally {
			closePersonalDb(db);
		}
	});
});
