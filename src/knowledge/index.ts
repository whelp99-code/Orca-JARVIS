import { createHash } from "node:crypto";
import type { VaultChunk } from "./types.js";
import type { KnowledgeVault } from "./vault.js";

export class KnowledgeIndex {
  constructor(private readonly vault: KnowledgeVault) {}

  chunks(projectId: string): readonly VaultChunk[] {
    return this.vault.list(projectId).flatMap(doc => {
      const parts = doc.content.split(/\n{2,}/).filter(Boolean);
      return parts.map(text => ({
        chunkHash: createHash("sha256").update(text).digest("hex"),
        documentId: `${doc.projectId}:${doc.path}:${doc.contentHash}`,
        text,
        revision: doc.revision,
        source: doc.source,
        classified: doc.classified,
        updatedAt: doc.updatedAt,
      }));
    });
  }
}
