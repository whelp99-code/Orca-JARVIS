import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import { JarvisError } from "../db.js";
import type { KnowledgeClassification, VaultDocument } from "./types.js";

const SECRET = /(AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH )?PRIVATE KEY|password\s*=\s*\S+)/i;
const INJECTION = /(ignore previous instructions|you are now|<\/?tool)/i;
const MAX_BYTES = 64 * 1024;

export function documentId(projectId: string, path: string, contentHash: string): string {
  return `${projectId}:${path}:${contentHash}`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function classify(path: string, content: string): KnowledgeClassification {
  if (path.includes("..") || path.startsWith(sep) || path.includes("\0")) throw new JarvisError("KNOWLEDGE_PATH_REJECTED");
  if (normalize(path).startsWith("..")) throw new JarvisError("KNOWLEDGE_PATH_REJECTED");
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_BYTES) throw new JarvisError("KNOWLEDGE_OVERSIZED");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) && !content.includes("\n")) throw new JarvisError("KNOWLEDGE_BINARY");
  if (SECRET.test(content)) return "redacted";
  if (INJECTION.test(content)) return "rejected";
  return "note";
}

export class KnowledgeVault {
  private readonly docs = new Map<string, VaultDocument & { content: string }>();
  constructor(private readonly file?: string) {
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Array<VaultDocument & { content: string }>;
        for (const doc of parsed) this.docs.set(`${doc.projectId}:${doc.path}`, doc);
      } catch {
        mkdirSync(dirname(file), { recursive: true });
      }
    }
  }

  upsert(projectId: string, path: string, content: string, source: string, at: string): VaultDocument {
    if (path.includes("authority") || source === "chat-db") throw new JarvisError("KNOWLEDGE_DOMAIN_SEPARATION");
    const classified = classify(path, content);
    const stored = classified === "redacted" ? "[redacted]" : content;
    const contentHash = hashContent(stored);
    const key = `${projectId}:${path}`;
    const prior = this.docs.get(key);
    const doc = {
      projectId,
      path,
      contentHash,
      revision: (prior?.revision ?? 0) + 1,
      source,
      classified,
      updatedAt: at,
      content: classified === "rejected" ? "" : stored,
    };
    this.docs.set(key, doc);
    this.flush();
    return doc;
  }

  rename(projectId: string, from: string, to: string, at: string): VaultDocument {
    const prior = this.docs.get(`${projectId}:${from}`);
    if (!prior) throw new JarvisError("KNOWLEDGE_NOT_FOUND");
    this.docs.delete(`${projectId}:${from}`);
    return this.upsert(projectId, to, prior.content, prior.source, at);
  }

  remove(projectId: string, path: string): void {
    this.docs.delete(`${projectId}:${path}`);
    this.flush();
  }

  list(projectId?: string): readonly (VaultDocument & { content: string })[] {
    return [...this.docs.values()].filter(doc => projectId === undefined || doc.projectId === projectId);
  }

  private flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(resolve(this.file)), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.list())}\n`);
  }
}
