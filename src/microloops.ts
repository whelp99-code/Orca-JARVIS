import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { ControlPlane } from "./control-plane.js";
import { ApprovedCommandExecutor } from "./approved-executor.js";
import { GjcRuntimeService } from "./service.js";

export type MicroLoopName = "observation" | "approved-command" | "gjc-dispatch" | "verification" | "recovery";
export interface MicroLoopHandler { name: MicroLoopName; interval_ms: number; run(now: Date): Promise<unknown>; }
export interface MicroLoopOutcome { name: string; state: "completed" | "failed" | "leased" | "idle" | "stale"; result?: unknown; error_code?: string; fence?: number; }

const message = (error: unknown) => error instanceof JarvisError ? error.code : error instanceof Error ? error.message : "MICROLOOP_ERROR";

export class DurableMicroLoopRuntime {
  private readonly control: ControlPlane;
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date()) { this.control = new ControlPlane(authority); }

  register(name: string, intervalMs: number, now = new Date()): void {
    if (!name || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 3_600_000) throw new JarvisError("MICROLOOP_SCHEDULE_INVALID"); const at = now.toISOString();
    this.authority.db.prepare("INSERT INTO microloop_schedules(loop_name,interval_ms,enabled,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(loop_name) DO UPDATE SET interval_ms=excluded.interval_ms,updated_at=excluded.updated_at").run(name, intervalMs, 1, at, at);
    this.authority.db.prepare("INSERT INTO microloop_status(loop_name,cycles,updated_at) VALUES(?,?,?) ON CONFLICT(loop_name) DO NOTHING").run(name, 0, at);
  }

  private claim(name: string, owner: string, now: Date, leaseMs: number): number | null {
    const at = now.toISOString(); const expires = new Date(now.getTime() + leaseMs).toISOString(); let fence: number | null = null;
    const tx = this.authority.db.transaction(() => {
      const schedule = this.authority.db.prepare("SELECT enabled FROM microloop_schedules WHERE loop_name=?").get(name) as { enabled: number } | undefined; if (!schedule || !schedule.enabled) throw new JarvisError("MICROLOOP_DISABLED");
      const row = this.authority.db.prepare("SELECT owner,fence,expires_at FROM microloop_leases WHERE loop_name=?").get(name) as { owner: string; fence: number; expires_at: string } | undefined;
      if (row && row.expires_at > at) return;
      fence = Number(row?.fence ?? 0) + 1;
      this.authority.db.prepare("INSERT INTO microloop_leases(loop_name,owner,fence,expires_at,heartbeat_at) VALUES(?,?,?,?,?) ON CONFLICT(loop_name) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at").run(name, owner, fence, expires, at);
      this.authority.db.prepare("UPDATE microloop_status SET last_started_at=?,last_error_code=NULL,updated_at=? WHERE loop_name=?").run(at, at, name);
    }); tx(); return fence;
  }

  async once(handler: MicroLoopHandler, owner = `microloop:${process.pid}`, now = new Date(), leaseMs = 60_000): Promise<MicroLoopOutcome> {
    this.register(handler.name, handler.interval_ms, now);
    const status = this.authority.db.prepare("SELECT last_completed_at FROM microloop_status WHERE loop_name=?").get(handler.name) as { last_completed_at: string | null } | undefined;
    if (status?.last_completed_at && new Date(status.last_completed_at).getTime() + handler.interval_ms > now.getTime()) return { name: handler.name, state: "idle" };
    const fence = this.claim(handler.name, owner, now, leaseMs); if (fence === null) return { name: handler.name, state: "leased" };
    try {
      const result = await handler.run(now); return this.fence(handler, owner, fence, result, now);
    } catch (error) {
      return this.fence(handler, owner, fence, undefined, now, message(error));
    }
  }

  private fence(handler: MicroLoopHandler, owner: string, fence: number, result: unknown, now: Date, errorCode?: string): MicroLoopOutcome {
    const at = now.toISOString(); let final: MicroLoopOutcome | undefined;
    const tx = this.authority.db.transaction(() => {
      const changed = this.authority.db.prepare("UPDATE microloop_leases SET expires_at=?,heartbeat_at=? WHERE loop_name=? AND owner=? AND fence=?").run(at, at, handler.name, owner, fence);
      if (changed.changes !== 1) { final = { name: handler.name, state: "stale", fence }; return; }
      if (errorCode !== undefined) {
        this.authority.db.prepare("UPDATE microloop_status SET cycles=cycles+1,last_completed_at=?,last_result_json=NULL,last_error_code=?,updated_at=? WHERE loop_name=?").run(at, errorCode, at, handler.name);
        this.control.emit({ event_id: `evt:microloop:${handler.name}:${at}:${fence}:failed`, event_type: "microloop.failed", source: owner, subject: handler.name, correlation_id: `microloop:${handler.name}`, payload: { fence, error_code: errorCode }, created_at: at });
        final = { name: handler.name, state: "failed", error_code: errorCode, fence };
      } else {
        const normalized = canonicalize(result ?? null);
        this.authority.db.prepare("UPDATE microloop_status SET cycles=cycles+1,last_completed_at=?,last_result_json=?,last_error_code=NULL,updated_at=? WHERE loop_name=?").run(at, normalized, at, handler.name);
        this.control.emit({ event_id: `evt:microloop:${handler.name}:${at}:${fence}`, event_type: "microloop.completed", source: owner, subject: handler.name, correlation_id: `microloop:${handler.name}`, payload: { fence, result }, created_at: at });
        final = { name: handler.name, state: result === null || result === undefined ? "idle" : "completed", result, fence };
      }
    }); tx(); return final ?? { name: handler.name, state: "stale", fence };
  }

  async batch(handlers: readonly MicroLoopHandler[], owner = `microloop:${process.pid}`, now = new Date()): Promise<MicroLoopOutcome[]> {
    const results: MicroLoopOutcome[] = []; for (const handler of handlers) results.push(await this.once(handler, owner, now)); return results;
  }

  status(): unknown[] { return this.authority.db.prepare("SELECT s.loop_name,s.interval_ms,s.enabled,t.cycles,t.last_started_at,t.last_completed_at,t.last_error_code,t.last_result_json,l.owner,l.fence,l.expires_at FROM microloop_schedules s JOIN microloop_status t ON t.loop_name=s.loop_name LEFT JOIN microloop_leases l ON l.loop_name=s.loop_name ORDER BY s.loop_name").all(); }
}

export class AgentOpsMicroLoops {
  private readonly control: ControlPlane;
  constructor(private readonly authority: AuthorityDb, private readonly approvedExecutor: ApprovedCommandExecutor, private readonly gjcService: GjcRuntimeService, private readonly observation: (now: Date) => Promise<unknown>) { this.control = new ControlPlane(authority); }

  handlers(): MicroLoopHandler[] {
    return [
      { name: "observation", interval_ms: 10_000, run: now => this.observation(now) },
      { name: "approved-command", interval_ms: 1_000, run: async now => { const request = this.control.nextApproved(); return request ? this.approvedExecutor.execute(request, "approved-command-loop", now) : null; } },
      { name: "gjc-dispatch", interval_ms: 1_000, run: now => this.gjcService.once(now.toISOString()) },
      { name: "verification", interval_ms: 5_000, run: async () => ({ awaiting_verification: Number((this.authority.db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE state='awaiting_verification'").get() as { count: number }).count), evidence: Number((this.authority.db.prepare("SELECT COUNT(*) AS count FROM verification_evidence").get() as { count: number }).count) }) },
      { name: "recovery", interval_ms: 5_000, run: async now => ({ recovered_control_claims: this.control.recoverExpired(now) }) },
    ];
  }
}
