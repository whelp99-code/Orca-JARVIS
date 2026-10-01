import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HandsError } from "./errors.js";

export type VaultPage = {
  readonly page_id: string;
  readonly title: string;
  readonly body: string;
};

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function encode(page: VaultPage): string {
  return `---\ntitle: ${JSON.stringify(page.title)}\n---\n${page.body}`;
}

function decode(pageId: string, raw: string): VaultPage {
  const match = /^---\ntitle: (.*)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new HandsError("UNAVAILABLE", pageId);
  return { page_id: pageId, title: JSON.parse(match[1] ?? "\"\"") as string, body: match[2] ?? "" };
}

/** Portable file vault. No unix sockets, systemd, or launchd. */
export class FileVault {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "pages"), { recursive: true });
  }

  remember(input: { readonly title: string; readonly body: string; readonly page_id?: string }): VaultPage {
    const page_id = input.page_id ?? createHash("sha256").update(`${input.title}\n${input.body}`).digest("hex").slice(0, 16);
    if (!ID.test(page_id)) throw new HandsError("VALIDATION", "page_id");
    const page = { page_id, title: input.title, body: input.body };
    writeFileSync(join(this.root, "pages", `${page_id}.md`), encode(page), { encoding: "utf8", mode: 0o600 });
    return page;
  }

  read(pageId: string): VaultPage {
    if (!ID.test(pageId)) throw new HandsError("VALIDATION", "page_id");
    try {
      return decode(pageId, readFileSync(join(this.root, "pages", `${pageId}.md`), "utf8"));
    } catch (error) {
      if (error instanceof HandsError) throw error;
      throw new HandsError("NOT_FOUND", pageId);
    }
  }

  search(query: string, limit: number): readonly VaultPage[] {
    const needle = query.toLowerCase();
    const hits: VaultPage[] = [];
    for (const name of readdirSync(join(this.root, "pages")).sort()) {
      if (!name.endsWith(".md")) continue;
      const page = this.read(name.slice(0, -3));
      if (`${page.title}\n${page.body}`.toLowerCase().includes(needle)) hits.push(page);
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
