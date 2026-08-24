import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ShellTimelineStore, fitWidth } from "../../shells/cli-jaw/src/jarvis/timeline-store.js";
import { TimelineStream, type TimelineEnvelope } from "../../src/timeline-stream.js";

function event(sequence: number, overrides: Partial<TimelineEnvelope> = {}): TimelineEnvelope {
  return {
    event_id: `evt-${sequence}`,
    task_id: `task-${sequence % 50}`,
    sequence,
    kind: sequence % 7 === 0 ? "approval" : "status",
    status: sequence % 11 === 0 ? "waiting_approval" : "completed",
    actor: "operator",
    title: `작업 ${sequence} 한글 제목`,
    evidence_refs: sequence % 5 === 0 ? [`evd-${sequence}`] : [],
    created_at: new Date(Date.parse("2026-08-23T12:00:00.000Z") + sequence * 1000).toISOString(),
    extra: { future_field: `keep-${sequence}` },
    ...overrides,
  };
}

describe("canonical timeline stream", () => {
  it("keeps three surfaces equal after a 10000-event load and forced gap replay", () => {
    const canonical = Array.from({ length: 10_000 }, (_, index) => event(index + 1));
    const jarvis = new TimelineStream();
    jarvis.ingest(canonical);
    const surfaces = ["web", "tui", "electron"] as const;
    const web = new ShellTimelineStore();
    const tui = new ShellTimelineStore();
    const electron = new ShellTimelineStore();
    for (const store of [web, tui, electron]) store.apply(canonical);
    const gapped = new ShellTimelineStore();
    const recovered = gapped.apply(canonical.filter(item => item.sequence !== 42));
    expect(recovered.gap).toBe(true);
    web.reconnect(canonical);
    tui.reconnect(canonical);
    electron.reconnect(canonical);
    const views = [
      web.render("web", 120),
      tui.render("tui", 72),
      electron.render("electron", 120),
    ];
    const jarvisSnap = jarvis.snapshot();
    for (const view of views) {
      expect(view.cursor).toBe(jarvisSnap.cursor);
      expect(view.pending_approval).toBe(jarvisSnap.pending_approval);
      expect(view.evidence_count).toBe(jarvisSnap.evidence_count);
      expect(view.rows.every(row => [...row.title].length <= (view.width === 72 ? 44 : 92))).toBe(true);
      expect(view.rows.some(row => row.next.includes("승인") || row.title.includes("작업"))).toBe(true);
    }
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/08/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/08/happy/canonical.json"), `${JSON.stringify({
      cursor: jarvisSnap.cursor,
      pending_approval: jarvisSnap.pending_approval,
      evidence_count: jarvisSnap.evidence_count,
      events: jarvisSnap.events.length,
      views: views.map(view => ({ surface: view.surface, width: view.width, cursor: view.cursor, pending_approval: view.pending_approval, evidence_count: view.evidence_count })),
    }, null, 2)}\n`);
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/08/happy/tui.txt"), views.find(view => view.surface === "tui")?.rows.map(row => `${row.status} ${row.owner} ${row.title} ${row.next}`).join("\n") ?? "");
  });

  it("ignores duplicates, replays gaps, and keeps unknown fields", () => {
    const stream = new TimelineStream();
    const first = [event(1), event(2), event(2), event(4)];
    const gap = stream.ingest(first);
    expect(gap.gap).toBe(true);
    stream.replayFrom([event(1), event(2), event(3), event(4, { extra: { future_field: "keep-4", newer: true } })]);
    const snap = stream.snapshot();
    expect(snap.events).toHaveLength(4);
    expect(snap.events[3]?.extra).toEqual({ future_field: "keep-4", newer: true });
    expect(stream.stats().duplicates).toBe(1);
    expect(stream.stats().rebuilds).toBe(1);
    expect(fitWidth("한글제목입니다", 4)).toBe("한글제…");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/08"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/08/recovery.json"), `${JSON.stringify({
      ...stream.stats(),
      finalEquality: snap.events.map(item => item.sequence),
    }, null, 2)}\n`);
  });
});
