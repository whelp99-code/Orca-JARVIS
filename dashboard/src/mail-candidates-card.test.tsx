// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MailCandidatesCard } from "./mail-candidates-card.js";
import { createMailCandidatesFixture } from "./mail-candidates-fixture.js";
import { mailCandidatesSummarySchema, type MailCandidatesReadAdapter } from "./mail-candidates-model.js";

afterEach(cleanup);
async function sample() {
  const adapter = createMailCandidatesFixture();
  const value = mailCandidatesSummarySchema.parse(await adapter.read(new AbortController().signal));
  if (value.proof_level !== "isolated-fixture") throw new Error("fixture proof required");
  return { adapter, value };
}
function source(name: "crm" | "sb") { return document.querySelector(`[data-candidate-source="${name}"]`); }
describe("read-only Mail candidate card", () => {
  it("renders native allowed metadata without treating it as fixture titles or authority", async () => {
    const data = {
      schema_version: 1, proof_level: "native-read", authority: "none", observed_at: "2026-10-09T00:00:00.000Z",
      crm: { state: "read", workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048", candidate_count: 1,
        recent: [{ id: "native-1", status: "<img src=x onerror=alert(1)>", confirmed: false,
          freshness: "producer_unverified", createdAt: "2026-10-08T00:00:00.000Z" }] },
      sb: { state: "read", workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048", candidate_count: 9 },
    };
    render(<MailCandidatesCard adapter={{ async read() { return data; } }} />);
    const rows = await screen.findAllByRole("listitem");
    expect(source("crm")?.getAttribute("data-candidate-count")).toBe("1");
    expect(source("sb")?.getAttribute("data-candidate-count")).toBe("9");
    expect(document.querySelector("[data-proof-level]")?.getAttribute("data-proof-level")).toBe("native-read");
    expect(rows[0]?.querySelector("span")?.textContent).toBe("확인 필요");
    expect(screen.getByTestId("crm-readable-summary").textContent).toContain(
      "확인 필요 1건 · 가장 오래된 것 1일 · 다음 행동: CRM에서 확인",
    );
    const observed = document.querySelector('time[datetime="2026-10-09T00:00:00.000Z"]');
    expect(observed?.textContent).toBe("2026/10/9(금) 09:00:00");
    expect(observed?.getAttribute("dateTime")).toBe("2026-10-09T00:00:00.000Z");
    expect(rows[0]?.querySelector("time")?.textContent).toBe("10/8(목)");
    expect(rows[0]?.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("does not infer oldest-candidate age from a truncated recent list", async () => {
    const data = {
      schema_version: 1, proof_level: "native-read", authority: "none", observed_at: "2026-10-09T00:00:00.000Z",
      crm: { state: "read", workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048", candidate_count: 9,
        recent: Array.from({ length: 5 }, (_, index) => ({
          id: `native-${index}`, status: "CANDIDATE", confirmed: false,
          freshness: "producer_unverified", createdAt: `2026-10-0${8 - index}T00:00:00.000Z`,
        })) },
      sb: { state: "unconnected" },
    };
    render(<MailCandidatesCard adapter={{ async read() { return data; } }} />);
    expect((await screen.findByTestId("crm-readable-summary")).textContent).toContain(
      "최근 5건 중 확인 필요 5건 · 가장 오래된 것 확인 필요 · 다음 행동: CRM에서 확인",
    );
    expect(screen.getByTestId("crm-readable-summary").textContent).not.toContain("1일");
  });
  it("states that no oldest unconfirmed candidate exists for a complete empty result", async () => {
    const data = {
      schema_version: 1, proof_level: "native-read", authority: "none", observed_at: "2026-10-09T00:00:00.000Z",
      crm: { state: "read", workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048",
        candidate_count: 0, recent: [] },
      sb: { state: "unconnected" },
    };
    render(<MailCandidatesCard adapter={{ async read() { return data; } }} />);
    expect((await screen.findByTestId("crm-readable-summary")).textContent).toContain(
      "확인 필요 0건 · 가장 오래된 미확인 항목 없음 · 다음 행동: 없음",
    );
  });
  it("preserves an independently read source when the other native reader refuses", async () => {
    const data = { schema_version: 1, proof_level: "native-read", authority: "none", observed_at: "2026-10-09T00:00:00.000Z",
      crm: { state: "unconnected", reason: "refused" },
      sb: { state: "read", workspace_id: "75c2b088-e5aa-5396-9e9e-6dfd77e50048", candidate_count: 9 } };
    render(<MailCandidatesCard adapter={{ async read() { return data; } }} />);
    await screen.findByRole("alert");
    expect(source("crm")?.hasAttribute("data-candidate-count")).toBe(false);
    expect(source("sb")?.getAttribute("data-candidate-count")).toBe("9");
  });
  it("shows unconnected sources without fabricated zero counts or actions", () => {
    render(<MailCandidatesCard />);
    expect(source("crm")?.getAttribute("data-source-state")).toBe("unconnected");
    expect(source("sb")?.hasAttribute("data-candidate-count")).toBe(false);
    expect(source("crm")?.hasAttribute("data-candidate-count")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders separate fixture counts and the five latest titles as text", async () => {
    const { adapter, value } = await sample();
    if (value.crm.state !== "read") throw new Error("fixture must include CRM");
    const first = value.crm.recent[0];
    if (first === undefined) throw new Error("fixture must include recent candidates");
    const title = "<img src=x onerror=alert(1)>";
    const data = { ...value, crm: { ...value.crm, recent: [{ ...first, title }, ...value.crm.recent.slice(1)] } };
    render(<MailCandidatesCard adapter={{ ...adapter, async read() { return data; } }} />);
    const rows = await screen.findAllByRole("listitem");
    expect(source("crm")?.getAttribute("data-candidate-count")).toBe("7");
    expect(source("sb")?.getAttribute("data-candidate-count")).toBe("3");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.querySelector("span")?.textContent).toBe(title);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-proof-level]")?.getAttribute("data-proof-level")).toBe("isolated-fixture");
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("distinguishes a read empty CRM from an unconnected SB", async () => {
    const { adapter, value } = await sample();
    if (value.crm.state !== "read") throw new Error("fixture must include CRM");
    let deliver: (value: unknown) => void = () => { throw new Error("delivery not initialized"); };
    const delivery = new Promise<unknown>(resolve => { deliver = resolve; });
    const data = { ...value, crm: { ...value.crm, candidate_count: 0, recent: [] }, sb: { state: "unconnected" } };
    render(<MailCandidatesCard adapter={{ ...adapter, read() { return delivery; } }} />);
    await act(async () => { deliver(data); await delivery; });
    expect(source("crm")?.getAttribute("data-candidate-count")).toBe("0");
    expect(source("sb")?.hasAttribute("data-candidate-count")).toBe(false);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
  it.each(["foreign", "missing", "too-many", "duplicate", "old-first"] as const)(
    "refuses invalid %s snapshots without retaining candidate counts", async kind => {
      const { adapter, value } = await sample();
      if (value.crm.state !== "read") throw new Error("fixture must include CRM");
      const crm = { ...value.crm };
      if (kind === "foreign") crm.workspace_id = "f4eb0c28-aa98-4d22-8f01-ff65e5e11220";
      if (kind === "too-many") crm.recent = [...crm.recent, ...crm.recent.slice(0, 1)];
      if (kind === "duplicate") crm.recent = [...crm.recent.slice(0, 1), ...crm.recent.slice(0, 1)];
      if (kind === "old-first") crm.recent = [...crm.recent].reverse();
      const data = kind === "missing" ? { ...value, crm: { state: "read", workspace_id: adapter.workspace_id } }
        : { ...value, crm };
      render(<MailCandidatesCard adapter={{ ...adapter, async read() { return data; } }} />);
      await screen.findByRole("alert");
      expect(source("crm")?.hasAttribute("data-candidate-count")).toBe(false);
      expect(source("sb")?.hasAttribute("data-candidate-count")).toBe(false);
    },
  );
  it("discards a pending delivery after the adapter changes", async () => {
    const { adapter, value } = await sample();
    let start: (value: AbortSignal) => void = () => { throw new Error("start not initialized"); };
    const started = new Promise<AbortSignal>(resolve => { start = resolve; });
    let deliver: (value: unknown) => void = () => { throw new Error("delivery not initialized"); };
    const delivery = new Promise<unknown>(resolve => { deliver = resolve; });
    const delayed: MailCandidatesReadAdapter = { workspace_id: adapter.workspace_id,
      read(signal) { start(signal); return delivery; } };
    const view = render(<MailCandidatesCard adapter={delayed} />);
    const signal = await started;
    view.rerender(<MailCandidatesCard />);
    await act(async () => { deliver(value); await delivery; });
    expect(signal.aborted).toBe(true);
    expect(document.querySelector("[data-candidate-id]")).toBeNull();
    expect(source("crm")?.hasAttribute("data-candidate-count")).toBe(false);
  });
});
