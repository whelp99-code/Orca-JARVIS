export type KnowledgeClassification = "note" | "rejected" | "redacted";

export type VaultDocument = {
  readonly projectId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly revision: number;
  readonly source: string;
  readonly classified: KnowledgeClassification;
  readonly updatedAt: string;
};

export type VaultChunk = {
  readonly chunkHash: string;
  readonly documentId: string;
  readonly text: string;
  readonly revision: number;
  readonly source: string;
  readonly classified: KnowledgeClassification;
  readonly updatedAt: string;
};

export type RetrievalHit = {
  readonly quote: string;
  readonly score: number;
  readonly provenance: { readonly projectId: string; readonly path: string; readonly revision: number };
  readonly classified: KnowledgeClassification;
  readonly untrusted: true;
};
