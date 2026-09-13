import type { AuthorityDb } from "./db.js";
import type { MemoryEvidenceInput } from "./context-assembler-input.js";
import { derivedMemoryTaskClosed } from "./memory-candidate-task-source.js";
import type { ContextSnapshotV1, ObservationEnvelopeV1 } from "./personal-contracts.js";
import { canonicalPersonalContractHash } from "./personal-validation.js";

/** Evidence kinds a recommendation action may cite. `owner_decision` is deliberately absent. */
export type AssembledCitationKind = "linux_live_fact" | "user_confirmed_principle";

export type AssembledCitation = {
  readonly reference: string;
  readonly evidence_id: string;
  readonly citation_kind: AssembledCitationKind;
};

export type UncitableEvidence = {
  readonly reference: string | null;
  readonly evidence_id: string;
  readonly reason: "advisory_local_source" | "unverified_observation" | "unconfirmed_memory"
    | "closed_task_source" | "unclassified_source";
};

export type AssembledCitations = {
  readonly citable: readonly AssembledCitation[];
  readonly uncitable: readonly UncitableEvidence[];
};

const LOCAL_TIMELINE_SOURCE = "src:pos:v1:task-timeline:local";
const LINUX_HOST = "host:pos:linux-control-plane";

type Classification =
  | { readonly reference: string; readonly citation_kind: AssembledCitationKind }
  | { readonly reference: string; readonly reason: UncitableEvidence["reason"] };

/**
 * What an assembled context can be cited for, derived from the source behind each piece.
 *
 * The assembler emits `context_observation` and `confirmed_memory`, while a recommendation action
 * cites `linux_live_fact`, `user_confirmed_principle` or `owner_decision`. The two vocabularies
 * describe different things: the first says where a piece of evidence sits in a context, the
 * second says what kind of claim an action is allowed to rest on. Translating between them by
 * renaming would turn an advisory row into an authority it never had, so each piece is classified
 * from its own source instead.
 *
 * A local task-timeline observation reports what a local SQLite cache said about a task; it is
 * never a live Linux fact and never an owner decision, so it stays uncitable and the actions that
 * need those slots cannot be built from it. Nothing here produces
 * `owner_decision` at all: an owner decision is an authority receipt from the owner, not something
 * assembled evidence can imply.
 */
export function classifyAssembledCitations(
  context: ContextSnapshotV1,
  observations: readonly ObservationEnvelopeV1[],
  memories: readonly MemoryEvidenceInput[],
): AssembledCitations {
  const byDigest = new Map<string, Classification>();
  for (const observation of observations) {
    byDigest.set(canonicalPersonalContractHash(observation), observationCitation(observation));
  }
  for (const memory of memories) byDigest.set(memory.digest, memoryCitation(memory));
  const citable: AssembledCitation[] = [];
  const uncitable: UncitableEvidence[] = [];
  for (const item of context.evidence) {
    const classified = byDigest.get(item.digest);
    if (classified === undefined) {
      uncitable.push({ reference: null, evidence_id: item.evidence_id,
        reason: "unclassified_source" });
    } else if ("citation_kind" in classified) {
      citable.push({ reference: classified.reference, evidence_id: item.evidence_id,
        citation_kind: classified.citation_kind });
    } else {
      uncitable.push({ reference: classified.reference, evidence_id: item.evidence_id,
        reason: classified.reason });
    }
  }
  return { citable, uncitable };
}

/** True when this context can support an action citing that kind of evidence. */
export function citationAvailable(
  citations: AssembledCitations, kind: AssembledCitationKind | "owner_decision",
): boolean {
  return citations.citable.some(item => item.citation_kind === kind);
}

function observationCitation(observation: ObservationEnvelopeV1): Classification {
  const reference = observation.id;
  // Source identity decides this, exactly as the assembler's own classification does. Authority
  // does not: an observation carries `authority_kind: "none"` whether it came from a live adapter
  // or from a local cache, so reading authority here would reject both or accept both.
  if (observation.source.source_id === LOCAL_TIMELINE_SOURCE
    || observation.source.source_kind === "timeline") {
    return { reference, reason: "advisory_local_source" };
  }
  if (observation.source.source_kind !== "live_adapter" || observation.source.host_id !== LINUX_HOST
    || observation.payload.kind !== "live_task") {
    return { reference, reason: "unclassified_source" };
  }
  return observation.payload.trust === "verified"
    ? { reference, citation_kind: "linux_live_fact" }
    : { reference, reason: "unverified_observation" };
}

function memoryCitation(memory: MemoryEvidenceInput): Classification {
  const reference = memory.memory_ref;
  return memory.trust === "user_confirmed"
    ? { reference, citation_kind: "user_confirmed_principle" }
    : { reference, reason: "unconfirmed_memory" };
}

/**
 * The citation authority a stored context can prove from what the database actually holds.
 *
 * Observations are classified from their own sealed envelopes, exactly as assembly classified them.
 * Memory evidence is not: the stored row carries no trust, and a confirmed principle is a licence
 * only the confirmation itself can grant, so this reports such a piece as unconfirmed rather than
 * inventing the trust that would make it citable. A caller that needs that licence has to prove it
 * somewhere this can read.
 */
export function citationAuthorityForContext(
  authority: AuthorityDb, contextId: string,
): AssembledCitations {
  const database = authority.db;
  const citable: AssembledCitation[] = [];
  const uncitable: UncitableEvidence[] = [];
  const observations = database.prepare(
    `SELECT o.observation_id AS reference, e.evidence_id AS evidence_id,
            p.canonical_envelope_json AS envelope
     FROM personal_context_observations o
     JOIN personal_context_evidence e ON e.context_id=o.context_id AND e.position=o.position
     JOIN personal_observations p ON p.observation_id=o.observation_id
     WHERE o.context_id=? ORDER BY o.position`,
  ).all(contextId) as { reference: string; evidence_id: string; envelope: string }[];
  for (const row of observations) {
    const envelope = JSON.parse(row.envelope) as ObservationEnvelopeV1;
    const classified = observationCitation(envelope);
    if ("citation_kind" in classified) {
      citable.push({ reference: row.reference, evidence_id: row.evidence_id,
        citation_kind: classified.citation_kind });
    } else {
      uncitable.push({ reference: row.reference, evidence_id: row.evidence_id,
        reason: classified.reason });
    }
  }
  // The sealed context is the proof for memories. Assembly omits anything whose trust is not
  // user_confirmed, so a piece sealed as `confirmed_memory` carries the confirmation the assembler
  // checked - and a piece sealed under any other kind carries none, whatever string sits beside it.
  const memories = database.prepare(
    `SELECT m.memory_ref AS reference, m.evidence_id AS evidence_id, e.evidence_kind AS sealed,
            m.evidence_digest AS digest
     FROM personal_context_memory_evidence m
     JOIN personal_context_evidence e ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
     WHERE m.context_id=? ORDER BY m.rowid`,
  ).all(contextId) as { reference: string; evidence_id: string; sealed: string; digest: string }[];
  for (const row of memories) {
    // A confirmation the owner has since closed is no longer one to cite: hiding the task that
    // produced a derived memory, or taking its project out of scope, closes reading it here the
    // same way it already closes the candidate's review, approval and write.
    if (row.sealed === "confirmed_memory" && derivedMemoryTaskClosed(authority, row.digest)) {
      uncitable.push({ reference: row.reference, evidence_id: row.evidence_id,
        reason: "closed_task_source" });
    } else if (row.sealed === "confirmed_memory") {
      citable.push({ reference: row.reference, evidence_id: row.evidence_id,
        citation_kind: "user_confirmed_principle" });
    } else {
      uncitable.push({ reference: row.reference, evidence_id: row.evidence_id,
        reason: "unconfirmed_memory" });
    }
  }
  return { citable, uncitable };
}
