import type { MemoryEvidenceInput } from "./context-assembler-input.js";
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
    | "unclassified_source";
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
