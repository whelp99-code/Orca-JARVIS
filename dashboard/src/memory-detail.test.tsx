import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRequestError, type MemoryClient } from "./memory-api.js";
import { MemoryDetail, type MemoryDetailOutcome } from "./memory-detail.js";
import type { MemoryRecord } from "./memory-types.js";

afterEach(cleanup);
const record: MemoryRecord = { record_token: "token-one", record_revision: "revision-one",
  title: "Fixture title", excerpt: "Fixture body", citation: "Memory citation", sensitivity: "personal",
  retention: { source: "policy", days: 365, expires_at: "2026-09-30T00:00:00.000Z" }, freshness: "fresh",
  provenance: { source_class: "memory", owner_class: "provider_owned", origin_label: "Second Brain",
    origin_revision: "origin-one" }, conflict_state: "none", history_state: "current", superseded_by: null,
  history: [{ operation: "correct", state: "staged", request_id: "memui:control:v1:aaaa", receipt_id: null,
    at: "2026-09-08T00:00:00.000Z" }], actions: ["inspect", "correct", "forget", "export"] };
const superseded: MemoryRecord = { ...record, title: "Superseded record", excerpt: null,
  citation: "Superseded citation", history_state: "superseded", superseded_by: "memui:control:v1:bbbb",
  history: [{ operation: "correct", state: "suppressed", request_id: "memui:control:v1:bbbb",
    receipt_id: "approval:bbbb", at: "2026-09-08T00:01:00.000Z" }], actions: [] };

function fixture(value = record, enabled = true) {
  const outcomes: MemoryDetailOutcome[] = [];
  let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void;
  const forget = vi.fn(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  const client = { forget, correct: forget, exportRecord: forget } as unknown as MemoryClient;
  render(<MemoryDetail record={value} client={client} enabled={enabled} onOutcome={outcome => outcomes.push(outcome)} />);
  return { outcomes, forget, settle: () => resolve({ state: "pending_approval" }), fail: (error: unknown) => reject(error) };
}

describe("MemoryDetail", () => {
  it("renders citation, provenance, sensitivity, retention, and bounded history", () => {
    fixture();
    const terms = screen.getAllByRole("term").map(node => node.textContent);
    expect(terms).toEqual(["Citation", "Provenance", "Sensitivity", "Retention", "Freshness", "History"]);
    expect(screen.getByText("Memory citation")).toBeVisible();
    expect(screen.getByText("Second Brain / provider_owned")).toBeVisible();
    const history = screen.getByRole("list", { name: "Record history" });
    expect(within(history).getByText("Correction")).toBeVisible();
    expect(within(history).getByText("pending owner approval")).toBeVisible();
    expect(within(history).getByText("memui:control:v1:aaaa")).toBeVisible();
  });

  it("shows a superseded record as history only, with no content and no actions", () => {
    fixture(superseded);
    expect(screen.getByText(/superseded by memui:control:v1:bbbb/)).toBeVisible();
    expect(screen.getByText("Receipt approval:bbbb")).toBeVisible();
    expect(screen.getByText("approved and effective")).toBeVisible();
    expect(document.body.textContent).not.toContain("Fixture body");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("sends exactly one forget command for a double click and shows a busy state", async () => {
    const { forget, settle, outcomes } = fixture();
    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: "Stage forgetting" });
    fireEvent.click(button); fireEvent.click(button);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Staging forgetting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage JSON export" })).toBeDisabled();
    await act(async () => { settle(); });
    expect(outcomes).toEqual([{ kind: "staged", message: "Pending owner approval" }]);
    expect(screen.getByRole("button", { name: "Stage forgetting" })).toBeDisabled();
  });

  it("reports a stale selection as a typed outcome with safe copy", async () => {
    const { fail, outcomes } = fixture();
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "Corrected body" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage correction" }));
    await act(async () => { fail(new MemoryRequestError("MEMORY_SELECTION_STALE", 404)); });
    expect(outcomes).toEqual([{ kind: "stale", message: expect.stringContaining("Search again") }]);
    expect(document.body.textContent).not.toContain("MEMORY_SELECTION_STALE");
    expect(screen.getByRole("button", { name: "Stage correction" })).toBeEnabled();
  });

  it("maps prohibited content and unknown failures to distinct safe copy", async () => {
    const { fail, outcomes } = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Stage JSON export" }));
    await act(async () => { fail(new MemoryRequestError("MEMORY_CONTENT_PROHIBITED", 400)); });
    fireEvent.click(screen.getByRole("button", { name: "Stage JSON export" }));
    await act(async () => { fail(new TypeError("network")); });
    expect(outcomes.map(outcome => outcome.kind)).toEqual(["failed", "failed"]);
    expect(outcomes[0]?.message).toContain("prohibited");
    expect(outcomes[1]?.message).toContain("Command could not be prepared");
  });

  it("offers no mutation controls while mutations are disabled", () => {
    const { forget } = fixture(record, false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/Changes are unavailable/)).toBeVisible();
    expect(forget).not.toHaveBeenCalled();
  });
});
