import { TimelineStream, type TimelineEnvelope, type TimelineSnapshot } from "../../../../src/timeline-stream.js";

export type SurfaceName = "web" | "tui" | "electron";

export type SurfaceView = {
  readonly surface: SurfaceName;
  readonly width: number;
  readonly cursor: number;
  readonly pending_approval: number;
  readonly evidence_count: number;
  readonly rows: readonly {
    readonly status: string;
    readonly owner: string;
    readonly age: string;
    readonly evidence: number;
    readonly next: string;
    readonly title: string;
  }[];
};

export class ShellTimelineStore {
  private readonly stream = new TimelineStream();
  private lastCursor = 0;

  apply(batch: readonly TimelineEnvelope[]): { readonly gap: boolean } {
    const result = this.stream.ingest(batch);
    this.lastCursor = this.stream.snapshot().cursor;
    return result;
  }

  reconnect(canonical: readonly TimelineEnvelope[]): TimelineSnapshot {
    return this.stream.replayFrom(canonical);
  }

  snapshot(): TimelineSnapshot {
    return this.stream.snapshot(this.lastCursor > 0 ? 0 : 0);
  }

  stats() {
    return this.stream.stats();
  }

  render(surface: SurfaceName, width: number, now = Date.parse("2026-08-23T13:00:00.000Z")): SurfaceView {
    const snap = this.stream.snapshot();
    return {
      surface,
      width,
      cursor: snap.cursor,
      pending_approval: snap.pending_approval,
      evidence_count: snap.evidence_count,
      rows: snap.events.slice(-20).map(event => ({
        status: event.status,
        owner: event.actor,
        age: `${Math.max(0, Math.floor((now - Date.parse(event.created_at)) / 1000))}s`,
        evidence: event.evidence_refs.length,
        next: event.status === "pending" || event.status === "waiting_approval" ? "승인 필요" : "대기",
        title: fitWidth(event.title, Math.max(8, width - 28)),
      })),
    };
  }
}

export function fitWidth(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(1, width - 1)).join("")}…`;
}
