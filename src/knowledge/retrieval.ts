import { JarvisError } from "../db.js";
import type { KnowledgeIndex } from "./index.js";
import type { RetrievalHit } from "./types.js";

export class KnowledgeRetrieval {
  constructor(private readonly index: KnowledgeIndex) {}

  query(projectId: string, term: string): readonly RetrievalHit[] {
    if (term.includes("..") || term.includes("\0")) throw new JarvisError("KNOWLEDGE_QUERY_REJECTED");
    return this.index.chunks(projectId).flatMap(chunk => {
      if (chunk.classified === "rejected") return [];
      const score = chunk.text.includes(term) ? 1 : chunk.text.toLowerCase().includes(term.toLowerCase()) ? 0.5 : 0;
      if (score === 0) return [];
      const [project, path] = chunk.documentId.split(":");
      return [{
        quote: chunk.text.slice(0, 240),
        score,
        provenance: { projectId: project ?? projectId, path: path ?? "", revision: chunk.revision },
        classified: chunk.classified,
        untrusted: true as const,
      }];
    }).sort((left, right) => right.score - left.score);
  }
}
