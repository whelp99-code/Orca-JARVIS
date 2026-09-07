import { randomUUID } from "node:crypto";
import { AuthorityDb, JarvisError } from "./db.js";

/** Owns one service instance's fenced lease and serializes its cycles. */
export class GjcRuntimeLease {
  private readonly owner: string;
  private fence: number | null = null;
  private active = false;

  constructor(private readonly db: AuthorityDb, worker: string) {
    if (!worker) throw new JarvisError("GJC_LEASE_INVALID");
    this.owner = `${worker}:${process.pid}:${randomUUID()}`;
  }

  async run<T>(now: string, action: (owner: string, fence: number) => Promise<T>):
    Promise<T | { processed: null; state: "leased" }> {
    if (this.active) return { processed: null, state: "leased" };
    this.active = true;
    try {
      if (this.fence !== null) {
        try {
          this.db.heartbeatGjcRuntimeLease(this.owner, this.fence, now);
        } catch (error) {
          if (!(error instanceof JarvisError) || error.code !== "GJC_STALE_LEASE") throw error;
          this.fence = null;
        }
      }
      this.fence ??= this.db.claimGjcRuntimeLease(this.owner, now);
      if (this.fence === null) return { processed: null, state: "leased" };
      return await action(this.owner, this.fence);
    } finally {
      this.active = false;
    }
  }

  release(now: string): void {
    if (this.active) throw new JarvisError("GJC_RUNTIME_BUSY");
    if (this.fence === null) return;
    this.db.releaseGjcRuntimeLease(this.owner, this.fence, now);
    this.fence = null;
  }
}
