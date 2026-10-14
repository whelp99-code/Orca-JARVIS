import type { AuthorityDb } from "./db.js";
import type { MemoryOutboxFailure, MemoryOutboxPhase } from "./memory-outbox-diagnostic.js";

type Fault = { readonly id: string; readonly failure: MemoryOutboxFailure };

/** Service-local reporting state; only committed database evidence retires faults. */
export class MemoryOutboxDiagnostics {
  private readonly writers = new Map<string, Fault>();
  private readonly observers = new Map<string, Fault>();
  private readonly controls = new Map<string, Fault>();
  private readonly phases = new Map<MemoryOutboxPhase, MemoryOutboxFailure>();
  private readonly retired: MemoryOutboxFailure[] = [];
  constructor(private readonly authority: AuthorityDb) {}

  recordPhase(failure: MemoryOutboxFailure): void { this.phases.set(failure.phase, failure); }
  resolvePhase(phase: MemoryOutboxPhase): void {
    const failure = this.phases.get(phase);
    if (failure !== undefined) { this.phases.delete(phase); this.retired.push(failure); }
  }
  private group(phase: MemoryOutboxPhase): Map<string, Fault> {
    return phase === "provider_write" ? this.writers : phase === "control_reconciliation" ? this.controls : this.observers;
  }
  record(id: string, failure: MemoryOutboxFailure): void {
    const group = this.group(failure.phase); const key = `${id}:${failure.phase}`;
    if (failure.phase !== "control_reconciliation" || !group.has(key)) group.set(key, { id, failure });
  }
  resolve(id: string, phase: MemoryOutboxPhase): void {
    const group = this.group(phase); const key = `${id}:${phase}`; const fault = group.get(key);
    if (fault !== undefined) { group.delete(key); this.retired.push(fault.failure); }
  }
  resolveOutbox(id: string): void {
    for (const phase of ["provider_write", "record_write_result", "dispatch",
      "provider_observation", "record_observation", "settlement"] as const) {
      this.resolve(id, phase);
    }
  }

  take(limit: number): { readonly failure: MemoryOutboxFailure | undefined; readonly retired: readonly MemoryOutboxFailure[] } {
    const selected: { readonly key: string; readonly fault: Fault; readonly group: Map<string, Fault>; readonly control: number }[] = [];
    for (const group of [this.writers, this.observers, this.controls]) {
      let count = 0;
      for (const [key, fault] of group) {
        selected.push({ key, fault, group, control: group === this.controls ? 1 : 0 });
        if (++count === limit) break;
      }
    }
    let failure: MemoryOutboxFailure | undefined = this.phases.values().next().value;
    if (selected.length > 0) {
      const terminal = new Set(this.authority.db.prepare(
        `WITH faults AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.control') AS control FROM json_each(?))
         SELECT f.id||':'||f.control FROM faults f
         LEFT JOIN memory_outbox o ON o.outbox_id=f.id
         LEFT JOIN memory_outbox_not_delivered n ON n.outbox_id=f.id
         LEFT JOIN control_command_requests r ON r.request_id=o.action_request_id
         WHERE n.outbox_id IS NOT NULL
           OR (f.control=0 AND (o.outbox_id IS NULL OR o.state IN ('settled','conflict')))
           OR (f.control=1 AND r.state IN ('completed','failed') AND EXISTS (
             SELECT 1 FROM control_command_effects e WHERE e.request_id=r.request_id AND e.effect_type='memory.outbox.reconciled'))`,
      ).pluck().all(JSON.stringify(selected.map(item => ({ id: item.fault.id, control: item.control })))));
      for (const item of selected) {
        if (terminal.has(`${item.fault.id}:${item.control}`)) {
          item.group.delete(item.key); this.retired.push(item.fault.failure);
        } else failure ??= item.fault.failure;
      }
    }
    return { failure, retired: this.retired.splice(0) };
  }
}
