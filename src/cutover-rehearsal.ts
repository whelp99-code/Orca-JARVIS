import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JarvisError } from "./db.js";

export type Snapshot = {
  readonly version: string;
  readonly hash: string;
  readonly rows: number;
  readonly bytes: number;
};

export type RehearsalResult = {
  readonly ok: boolean;
  readonly blocked: boolean;
  readonly reason?: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
  readonly rollbackTarget: string;
};

export function snapshotOf(path: string, version: string): Snapshot {
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.from("");
  return {
    version,
    hash: createHash("sha256").update(bytes).digest("hex"),
    rows: bytes.toString("utf8").split("\n").filter(Boolean).length,
    bytes: bytes.length,
  };
}

export class CutoverRehearsal {
  constructor(private readonly home: string) {
    mkdirSync(join(home, "old"), { recursive: true });
    mkdirSync(join(home, "new"), { recursive: true });
  }

  seed(contents: string): string {
    const src = join(this.home, "old", "state.txt");
    writeFileSync(src, contents);
    return src;
  }

  run(opts: { corrupt?: boolean; healthFail?: boolean } = {}): RehearsalResult {
    const src = join(this.home, "old", "state.txt");
    const dest = join(this.home, "new", "state.txt");
    copyFileSync(src, dest);
    if (opts.corrupt) writeFileSync(dest, "CORRUPT");
    const before = snapshotOf(src, "N");
    const after = snapshotOf(dest, "N+1");
    const invariantsMatch = before.hash === after.hash && before.rows === after.rows;
    if (!invariantsMatch || opts.healthFail) {
      return { ok: false, blocked: true, reason: opts.healthFail ? "health_failed" : "invariant_mismatch", before, after, rollbackTarget: src };
    }
    return { ok: true, blocked: false, before, after, rollbackTarget: src };
  }

  rollback(result: RehearsalResult): Snapshot {
    const dest = join(this.home, "new", "state.txt");
    copyFileSync(result.rollbackTarget, dest);
    return snapshotOf(dest, "N");
  }
}
