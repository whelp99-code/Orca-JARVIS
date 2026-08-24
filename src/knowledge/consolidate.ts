import { createHash } from "node:crypto";
import type { KnowledgeIndex } from "./index.js";

export class KnowledgeConsolidate {
  private watermark = "";
  constructor(private readonly index: KnowledgeIndex) {}

  commit(projectId: string): string {
    const chunks = this.index.chunks(projectId);
    const next = createHash("sha256").update(chunks.map(chunk => chunk.chunkHash).join("")).digest("hex");
    this.watermark = next;
    return this.watermark;
  }

  get highWaterMark(): string {
    return this.watermark;
  }
}
