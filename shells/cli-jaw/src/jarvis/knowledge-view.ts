import type { RetrievalHit } from "../../../../src/knowledge/types.js";

export function presentHits(hits: readonly RetrievalHit[]): readonly { readonly quote: string; readonly untrusted: true }[] {
  return hits.map(hit => ({ quote: hit.quote, untrusted: true as const }));
}
