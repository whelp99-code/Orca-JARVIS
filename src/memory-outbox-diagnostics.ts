import type { AuthorityDb } from "./db.js";
import { markMemoryOutboxCycleRetry, memoryOutboxFailure, tagMemoryOutboxFailure,
  type MemoryOutboxFailure, type MemoryOutboxPhase } from "./memory-outbox-diagnostic.js";

type Fault = { readonly id: string; readonly order: number; readonly failure: MemoryOutboxFailure; readonly shown?: MemoryOutboxFailure };
const SAMPLE_CAPACITY = 32;
const RECEIPT_CAPACITY = 3 * SAMPLE_CAPACITY + 12;

/** Bounded diagnostic samples, not an outage ledger. Eviction is never recovery. */
export class MemoryOutboxDiagnostics {
  private readonly writers = new Map<string, Fault>();
  private readonly observers = new Map<string, Fault>();
  private readonly controls = new Map<string, Fault>();
  private readonly phases = new Map<MemoryOutboxPhase, MemoryOutboxFailure>();
  private readonly retired: MemoryOutboxFailure[] = [];
  private shown: MemoryOutboxFailure | undefined;
  private pin: { readonly key: string; readonly group: Map<string, Fault> } | undefined;
  private readonly cursors = new Map<Map<string, Fault>, number>();
  private order = 0;
  constructor(private readonly authority: AuthorityDb) {}

  recordPhase(failure: MemoryOutboxFailure): void { this.phases.set(failure.phase, failure); }
  resolvePhase(phase: MemoryOutboxPhase): void {
    const failure = this.phases.get(phase);
    if (failure !== undefined) { this.phases.delete(phase); this.retire(failure); }
  }
  private group(phase: MemoryOutboxPhase): Map<string, Fault> {
    return phase === "provider_write" ? this.writers : phase === "control_reconciliation" ? this.controls : this.observers;
  }
  record(id: string, failure: MemoryOutboxFailure, reported = false): void {
    const group = this.group(failure.phase); const key = `${id}:${failure.phase}`;
    const previous = group.get(key);
    const current = !reported && previous?.failure.cause_code === failure.cause_code ? previous.failure : failure;
    if (previous === undefined && group.size === SAMPLE_CAPACITY) {
      for (const victim of group.keys()) {
        if (this.pin?.group === group && this.pin.key === victim) continue;
        group.delete(victim); break;
      }
    }
    group.set(key, { id, order: previous?.order ?? ++this.order, failure: current,
      ...(reported ? { shown: current } : previous?.shown === undefined ? {} : { shown: previous.shown }) });
    if (reported) { this.pin = { key, group }; this.shown = current; }
  }
  resolve(id: string, phase: MemoryOutboxPhase): void {
    const group = this.group(phase); const key = `${id}:${phase}`; const fault = group.get(key);
    if (fault !== undefined) {
      group.delete(key); this.retire(fault.failure);
      if (fault.shown !== undefined && fault.shown !== fault.failure) this.retire(fault.shown);
    }
  }
  resolveOutbox(id: string): void {
    for (const phase of ["provider_write", "record_write_result", "dispatch",
      "provider_observation", "record_observation", "settlement"] as const) {
      this.resolve(id, phase);
    }
  }

  private retire(failure: MemoryOutboxFailure): void {
    if (this.retired.includes(failure)) return;
    this.retired.push(failure);
    if (this.retired.length > RECEIPT_CAPACITY) {
      const victim = this.retired.findIndex(value => value !== this.shown);
      this.retired.splice(victim, 1);
    }
  }

  take(limit: number): { readonly failure: MemoryOutboxFailure | undefined; readonly retired: readonly MemoryOutboxFailure[] } {
    try { return this.select(limit); }
    catch (error) {
      const failure = markMemoryOutboxCycleRetry(memoryOutboxFailure(tagMemoryOutboxFailure("cycle", error)));
      this.recordPhase(failure); this.shown = failure;
      return { failure, retired: [] };
    }
  }

  private select(limit: number): { readonly failure: MemoryOutboxFailure | undefined; readonly retired: readonly MemoryOutboxFailure[] } {
    const selected: { readonly key: string; readonly fault: Fault; readonly group: Map<string, Fault>; readonly control: number }[] = [];
    for (const group of [this.writers, this.observers, this.controls]) {
      let count = 0;
      const cursor = this.cursors.get(group) ?? 0;
      const page = [...group].sort((a, b) =>
        Number(a[1].order <= cursor) - Number(b[1].order <= cursor) || a[1].order - b[1].order);
      for (const [key, fault] of page) {
        selected.push({ key, fault, group, control: group === this.controls ? 1 : 0 });
        if (++count === limit) break;
      }
    }
    let failure: MemoryOutboxFailure | undefined = [...this.phases.values()]
      .find(value => value.phase !== "control_reconciliation" && value.phase !== "cycle");
    if (selected.length > 0) {
      const terminal = new Set(this.authority.db.prepare(
        `WITH faults AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.control') AS control FROM json_each(?))
         SELECT f.id||':'||f.control FROM faults f
         LEFT JOIN memory_outbox o ON o.outbox_id=f.id
         LEFT JOIN memory_outbox_not_delivered n ON n.outbox_id=f.id
         LEFT JOIN control_command_requests r ON r.request_id=o.action_request_id
         WHERE n.outbox_id IS NOT NULL OR o.outbox_id IS NULL
           OR (f.control=0 AND o.state IN ('settled','conflict','failed','expired'))
           OR (f.control=1 AND (
             EXISTS (SELECT 1 FROM control_command_revocations v
               WHERE v.request_id=r.request_id OR v.receipt_id=o.action_receipt_id)
             OR EXISTS (SELECT 1 FROM authority_revocations v
               WHERE v.reference IN (r.request_id,r.command_digest,o.action_receipt_id))
             OR (r.state IN ('completed','failed') AND EXISTS (
               SELECT 1 FROM control_command_effects e WHERE e.request_id=r.request_id AND e.effect_type='memory.outbox.reconciled'))))`,
      ).pluck().all(JSON.stringify(selected.map(item => ({ id: item.fault.id, control: item.control })))));
      for (const item of selected) {
        if (terminal.has(`${item.fault.id}:${item.control}`)) this.resolve(item.fault.id, item.fault.failure.phase);
        // Admission order is separate from paging; eviction cannot reset fairness.
        this.cursors.set(item.group, item.fault.order);
      }
    }
    this.resolvePhase("cycle");
    for (const group of [this.writers, this.observers, this.controls]) {
      const pinned = this.pin?.group === group ? group.get(this.pin.key) : undefined;
      const fault = pinned ?? group.values().next().value;
      if (failure === undefined && fault !== undefined) {
        const key = `${fault.id}:${fault.failure.phase}`;
        group.set(key, { ...fault, shown: fault.failure });
        this.pin = { key, group }; failure = fault.failure;
      }
    }
    failure ??= this.phases.get("control_reconciliation");
    this.shown = failure;
    return { failure, retired: this.retired.splice(0) };
  }
}
