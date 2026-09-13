import { readFileSync } from "node:fs";
import { AuthorityDb, DailyLoopStore, Recommendations, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { defaultPriorityCandidates } from "./priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "./priority-engine-input.js";
import { persistTask18Context, RECOMMENDATION_NOW, REPLACEMENT_ID, task18Request, task18Substitute }
  from "./recommendation-fixture.js";

export const PUBLICATION_AT = new Date(RECOMMENDATION_NOW);
const request = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  vectors: { correction: { request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request;
export const SECOND_SOURCE_TARGET = request.targets[0]!.target_digest;

export async function morningPublicationFixture(db: AuthorityDb, options: {
  lineage?: boolean; phase?: "morning" | "evening"; date?: string; preceding?: boolean; empty?: boolean;
  lease_ms?: number;
} = {}) {
  await db.migrate();
  if (!options.empty) {
    const context = await persistTask18Context(db);
    const projections = new MemoryProjectionAuthority(db);
    if (options.lineage !== false) projections.bind({ kind: "context", id: context.id, component_id: context.id },
      [{ target_digest: `sha256:${"c".repeat(64)}` }], PUBLICATION_AT);
    for (const id of [undefined, REPLACEMENT_ID]) {
      const input = task18Request(context, id); const wanted = new Set(input.ranking.actions.map(action => action.action_id));
      // The slot names the priority fixtures read are not what the database can back: the same
      // substitution the context fixture applied has to reach this ranking too.
      const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(),
        task18Substitute(context, priorityEngineInput({
          candidates: defaultPriorityCandidates().filter(item => wanted.has(String(item["action_id"]))) })));
      new Recommendations(db).create({ ...input, ranking });
    }
    if (options.lineage !== false) projections.bind({ kind: "recommendation", id: REPLACEMENT_ID, component_id: REPLACEMENT_ID },
      [{ target_digest: SECOND_SOURCE_TARGET }], PUBLICATION_AT);
  }
  const store = new DailyLoopStore(db);
  const definitions = options.preceding ? [{ key: "refresh_context", sequence: 1 }, { key: "morning_reconcile", sequence: 2 }]
    : [{ key: "morning_reconcile", sequence: 1 }];
  const run = store.prepare({ due: { kind: "due", local_date: options.date ?? "2026-08-28", phase: options.phase ?? "morning",
    scheduled_at: PUBLICATION_AT.toISOString() }, created_at: PUBLICATION_AT,
  deadline_at: new Date(PUBLICATION_AT.getTime() + 600_000), steps: definitions });
  const claim = store.claim({ run_id: run, owner_id: "morning-publisher", at: PUBLICATION_AT,
    lease_ms: options.lease_ms ?? 300_000 });
  return { store, claim, step: store.steps(run).at(-1)!, run };
}

export function forgetSecondPublicationSource(db: AuthorityDb) {
  return new MemoryTombstoneChain(db, Buffer.alloc(32, 1)).append({ operation: "correct", lane_id: request.lane_id,
    targets: request.targets, target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
    authority_receipt_digest: request.tombstone_chain_delta[0]!.authority_receipt_digest,
    payload_digest: request.delegation.payload_digest, effective_at: request.created_at });
}
