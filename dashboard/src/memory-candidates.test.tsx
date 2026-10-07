import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCandidates } from "./memory-candidates.js";
import { MemoryEffects } from "./memory-effects.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryClient } from "./memory-api.js";
import type { MemoryCandidates as CandidatePage, MemoryCandidateReview } from "./memory-types.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const review: MemoryCandidateReview = { schema_version: 1, resource: "memory-candidate-review",
  candidate_id: "candidate-one", review_digest: "sha256:review-one", operation: "remember",
  subject: "Summary preference", statement: "Use concise summaries.", source_id: "owner-session",
  source_version: "v1", sensitivity: "personal", retention_days: 30, expires_at: "2126-01-01T00:00:00.000Z" };
const value: CandidatePage = { schema_version: 1, resource: "memory-candidates", generated_at: "2026-09-08",
  state: "ready", items: [{ candidate_id: review.candidate_id, candidate_revision: "revision-one",
    kind: "inference", operation: "remember", confidence: "inferred", sensitivity: "normal",
    retention: { source: "policy", days: 30 }, expires_at: review.expires_at, reason: "Owner confirmation required",
    conflict: "none", provenance: "JARVIS candidate source", review_state: "unavailable", actions: ["inspect"] }],
  page: { limit: 20, returned: 1, has_more: false, next_cursor: null } };

describe("candidate review actions", () => {
  it("loads review before offering decisions and suppresses duplicate clicks while awaiting the server", async () => {
    const onReview = vi.fn(async () => {}); const onChanged = vi.fn();
    let finish!: (value: unknown) => void;
    const decision = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const client = { candidateDecision: decision } as unknown as MemoryClient;
    const props = { value, pending: false, client, enabled: true, onReview, onChanged };
    const rendered = render(<MemoryCandidates {...props} />);
    expect(screen.queryByText(review.statement)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "확인 준비" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "후보 보기" }));
    expect(onReview).toHaveBeenCalledWith(review.candidate_id);
    rendered.rerender(<MemoryCandidates {...props} review={review} />);
    const confirm = screen.getByRole("button", { name: "확인 준비" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(decision).toHaveBeenCalledExactlyOnceWith(review.candidate_id, review.review_digest, "confirm");
    await act(async () => { finish({ request_id: "command-one", state: "pending_approval" }); });
    expect(screen.getByRole("status")).toHaveTextContent("pending_approval");
    expect(screen.getByRole("link", { name: "승인함 열기" })).toHaveAttribute("href", "/approvals");
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("never labels approval or acceptance as stored", () => {
    render(<MemoryEffects pending={false} progress={{ schema_version: 1, resource: "memory-remember-progress", generated_at: "now",
      has_more: false, items: [{ request_id: "pending-command", state: "approved", outbox_state: "queued",
        failure_code: null, stored: false }, { request_id: "done-command", state: "completed",
        outbox_state: "settled", failure_code: null, stored: true }] }} />);
    expect(screen.getByText("저장 명령: approved")).toBeVisible();
    expect(screen.getAllByText("기억 저장됨")).toHaveLength(1);
  });
  it("does not refresh private state when a prepared command responds after the view was closed", async () => {
    const onChanged = vi.fn(); let finish!: (value: unknown) => void;
    const client = { candidateDecision: () => new Promise(resolve => { finish = resolve; }) } as unknown as MemoryClient;
    const rendered = render(<MemoryCandidates pending={false} value={value} review={review} client={client}
      enabled onReview={async () => {}} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 준비" })); rendered.unmount();
    await act(async () => { finish({ request_id: "persisted-command", state: "pending_approval" }); });
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("discards a late detail after privacy clearing and removes expired review content", async () => {
    vi.useFakeTimers(); const now = new Date("2026-09-08T00:00:00Z").getTime();
    vi.setSystemTime(now); let finish!: (value: MemoryCandidateReview) => void;
    const candidate = vi.fn(() => new Promise<MemoryCandidateReview>(resolve => { finish = resolve; }));
    const store = createMemoryStore({ client: { candidate } as unknown as MemoryClient,
      eventSourceFactory: () => { throw new Error("unused"); }, clock: () => Date.now() });
    const first = store.review(review.candidate_id); store.clearPrivate();
    finish(review); await first; expect(store.getSnapshot().review).toBeUndefined();
    const second = store.review(review.candidate_id);
    finish({ ...review, expires_at: new Date(now + 1000).toISOString() }); await second;
    expect(store.getSnapshot().review?.statement).toBe(review.statement);
    vi.advanceTimersByTime(1000); expect(store.getSnapshot().review).toBeUndefined(); store.stop();
  });
});
