import { createHash } from "node:crypto";
import { JarvisError } from "../db.js";

export type CandidateType = "model" | "agent" | "prompt" | "skill" | "routing" | "budget" | "workflow";

export type Candidate = {
  readonly id: string;
  readonly hash: string;
  readonly type: CandidateType;
  readonly version: string;
  readonly source: string;
};

export function candidateHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class CandidateRegistry {
  private readonly items = new Map<string, Candidate>();

  register(input: Omit<Candidate, "hash"> & { readonly body: string }): Candidate {
    if (input.type === "workflow" && input.source === "authority-kernel") throw new JarvisError("EVOLUTION_AUTHORITY_KERNEL");
    const candidate: Candidate = { id: input.id, hash: candidateHash(input.body), type: input.type, version: input.version, source: input.source };
    if (this.items.has(candidate.id)) throw new JarvisError("EVOLUTION_CANDIDATE_IMMUTABLE");
    this.items.set(candidate.id, candidate);
    return candidate;
  }

  get(id: string): Candidate {
    const item = this.items.get(id);
    if (!item) throw new JarvisError("EVOLUTION_CANDIDATE_UNKNOWN");
    return item;
  }
}
