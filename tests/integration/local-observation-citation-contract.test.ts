import { afterEach, expect, it } from "vitest";
import { assemblePersonalContext } from "../../src/context-assembler.js";
import { AuthorityDb } from "../../src/db.js";
import {
  citationAvailable, classifyAssembledCitations,
} from "../../src/personal-context-citation-contract.js";
import { parseObservationEnvelopeV1 } from "../../src/personal-validation.js";
import {
  admitLocalChainObservation, localChainDeclaredMemory, LOCAL_CHAIN_AT, LOCAL_CHAIN_PRINCIPLE_REF,
} from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const assemble = (observations: readonly unknown[], memories: readonly unknown[] = [
  localChainDeclaredMemory]) => assemblePersonalContext({
  purpose: "daily_prioritization", query: "what now?", clock: AT, expires_in_ms: 240_000,
  budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 4096 },
  observations, pending_authority_refs: [], memories,
});

/** A live Orca task envelope, written at the contract boundary the live adapter also writes. */
const liveObservation = (trust: "verified" | "inferred") => parseObservationEnvelopeV1({
  schema_version: 1,
  id: `obs:pos:v1:src:pos:v1:orca:live:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f73${trust === "verified" ? "01" : "02"}`,
  created_at: AT, observed_at: AT, valid_at: AT,
  source: { source_id: "src:pos:v1:orca:live", source_kind: "live_adapter",
    host_id: "host:pos:linux-control-plane", source_version: "live-v1", evidence_ref: "run:1" },
  authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
  freshness: { state: "fresh", checked_at: AT, fresh_until: "2026-08-28T12:09:59.999Z" },
  expires_at: "2026-08-28T12:10:00.000Z",
  idempotency_key: `idem:pos:v1:observation:${trust === "verified" ? "c".repeat(64) : "d".repeat(64)}`,
  correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7303", causation_id: null,
  payload: { kind: "live_task", subject: "task:live", value: { state: "running" }, trust,
    sensitivity: "personal", cursor: null, checkpoint: null,
    content_digest: `sha256:${"a".repeat(64)}`, state: "fresh" },
  policy_decision: { decision: "allow", policy_version: "live-v1", reason_codes: ["POLICY_SATISFIED"] },
  evidence: [{ evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7304",
    digest: `sha256:${"b".repeat(64)}`, kind: "structured_ref", source_id: "src:pos:v1:orca:live",
    observed_at: AT }], receipt: null,
});

it("never lets an advisory local observation stand in for a live fact or an owner decision",
  async () => {
    const db = new AuthorityDb(tempDb()); opened.push(db);
    const { observation } = await admitLocalChainObservation(db);
    const context = assemble([observation]);
    // The assembler's own vocabulary, which no citation slot accepts as written.
    expect(context.evidence.map(item => item.kind))
      .toEqual(["context_observation", "confirmed_memory"]);

    const citations = classifyAssembledCitations(context, [observation], [localChainDeclaredMemory]);
    expect(citations.citable).toEqual([{ reference: LOCAL_CHAIN_PRINCIPLE_REF,
      evidence_id: context.evidence[1]?.evidence_id, citation_kind: "user_confirmed_principle" }]);
    expect(citations.uncitable).toEqual([{ reference: observation.id,
      evidence_id: context.evidence[0]?.evidence_id, reason: "advisory_local_source" }]);
    // So the slots that would make an action actionable cannot be filled from this context.
    expect(citationAvailable(citations, "linux_live_fact")).toBe(false);
    expect(citationAvailable(citations, "owner_decision")).toBe(false);
    expect(citationAvailable(citations, "user_confirmed_principle")).toBe(true);
  }, 60_000);

it("cites a verified live Linux task and refuses the same envelope when it is only reported", () => {
  const verified = liveObservation("verified");
  const cited = classifyAssembledCitations(assemble([verified]), [verified],
    [localChainDeclaredMemory]);
  expect(cited.citable.map(item => item.citation_kind))
    .toEqual(["linux_live_fact", "user_confirmed_principle"]);
  expect(cited.uncitable).toEqual([]);

  // Trust is what the assembler already filters on; the contract states the same rule once more
  // rather than inheriting it silently, so a merely inferred envelope stays uncitable here too.
  const inferred = liveObservation("inferred");
  const refused = classifyAssembledCitations(assemble([verified]), [inferred],
    [localChainDeclaredMemory]);
  expect(refused.citable.map(item => item.citation_kind)).toEqual(["user_confirmed_principle"]);
  expect(refused.uncitable.map(item => item.reason)).toEqual(["unclassified_source"]);
}, 60_000);

it("refuses a memory the user never confirmed and evidence it cannot account for", () => {
  const verified = liveObservation("verified");
  const unconfirmed = { ...localChainDeclaredMemory, trust: "inferred" as const };
  const context = assemble([verified]);
  const citations = classifyAssembledCitations(context, [verified], [unconfirmed]);
  expect(citations.citable.map(item => item.citation_kind)).toEqual(["linux_live_fact"]);
  expect(citations.uncitable).toEqual([{ reference: unconfirmed.memory_ref,
    evidence_id: context.evidence[1]?.evidence_id, reason: "unconfirmed_memory" }]);

  // Evidence whose input was not supplied is never treated as satisfied by omission.
  const orphaned = classifyAssembledCitations(context, [verified], []);
  expect(orphaned.uncitable).toEqual([{ reference: null,
    evidence_id: context.evidence[1]?.evidence_id, reason: "unclassified_source" }]);
}, 60_000);
