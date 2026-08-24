export type TimelineEnvelope = {
  readonly event_id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly status: string;
  readonly actor: string;
  readonly title: string;
  readonly evidence_refs: readonly string[];
  readonly created_at: string;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export type TimelineSnapshot = {
  readonly cursor: number;
  readonly events: readonly TimelineEnvelope[];
  readonly pending_approval: number;
  readonly evidence_count: number;
};

export class TimelineStream {
  private readonly byId = new Map<string, TimelineEnvelope>();
  private readonly order: string[] = [];
  private rebuilds = 0;
  private duplicates = 0;
  private gapReplays = 0;

  ingest(batch: readonly TimelineEnvelope[]): { readonly gap: boolean } {
    const sorted = [...batch].sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
    let gap = false;
    let expected = this.nextSequence();
    for (const event of sorted) {
      if (this.byId.has(event.event_id)) {
        this.duplicates += 1;
        continue;
      }
      if (event.sequence > expected) {
        gap = true;
        this.gapReplays += 1;
      }
      this.byId.set(event.event_id, event);
      this.order.push(event.event_id);
      if (event.sequence === expected) expected += 1;
      else if (event.sequence < expected) expected = this.nextSequence();
      else expected = event.sequence + 1;
    }
    return { gap };
  }

  replayFrom(source: readonly TimelineEnvelope[]): TimelineSnapshot {
    this.byId.clear();
    this.order.length = 0;
    this.rebuilds += 1;
    this.ingest(source);
    return this.snapshot();
  }

  snapshot(after = 0): TimelineSnapshot {
    const events = this.order.map(id => this.byId.get(id)).filter((event): event is TimelineEnvelope => event !== undefined && event.sequence > after);
    return {
      cursor: events.reduce((max, event) => Math.max(max, event.sequence), after),
      events,
      pending_approval: events.filter(event => event.status === "pending" || event.status === "waiting_approval").length,
      evidence_count: events.reduce((sum, event) => sum + event.evidence_refs.length, 0),
    };
  }

  stats() {
    return { rebuilds: this.rebuilds, duplicates: this.duplicates, gapReplays: this.gapReplays, size: this.byId.size };
  }

  private nextSequence(): number {
    let max = 0;
    for (const id of this.order) {
      const event = this.byId.get(id);
      if (event && event.sequence > max) max = event.sequence;
    }
    return max + 1;
  }
}
