import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCandidates } from "./memory-candidates.js";
import { MemoryConflicts } from "./memory-conflicts.js";
import { MemoryEffects } from "./memory-effects.js";
import { providerState } from "./memory-page.js";
import { MemorySearch } from "./memory-search.js";
import type { MemoryClient } from "./memory-api.js";
import type { MemoryConflicts as ConflictPage, MemoryEffects as EffectPage, MemorySearch as SearchPage,
  MemorySnapshot } from "./memory-types.js";

afterEach(cleanup);
const at = "2026-09-08T00:00:00.000Z";
const search = (state: string, omissions: string[] = []): SearchPage => ({ schema_version: 1,
  resource: "memory-search", state, generated_at: at, checked_at: at, fresh_until: at, privacy_epoch: 0,
  query_revision: "q", resource_revision: "r", provider_generation: null, truncated: false, omissions, items: [] });
const ready: MemorySnapshot = { state: "ready", status: { schema_version: 1, resource: "memory-status",
  state: "ready", privacy_epoch: 0, checked_at: at, fresh_until: at, contract_schema: 4, mutations_enabled: true } };

describe("MemorySearch provider states", () => {
  it("never presents an offline provider as an empty result", () => {
    render(<MemorySearch result={search("offline", ["offline"])} onSearch={async () => {}} onSelect={() => {}} />);
    expect(screen.queryByText("No visible memory records")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/provider offline/i);
  });

  it("announces an unavailable provider distinctly from no data", () => {
    render(<MemorySearch result={search("unavailable", ["provider_unavailable"])} onSearch={async () => {}} onSelect={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/provider unavailable/i);
  });

  it("explains privacy-withheld results without claiming the memory is empty", () => {
    render(<MemorySearch result={search("no_data", ["privacy_filtered"])} onSearch={async () => {}} onSelect={() => {}} />);
    expect(screen.getByText(/withheld by owner privacy decisions/)).toBeVisible();
  });

  it("keeps the plain empty state for a genuinely empty current read", () => {
    render(<MemorySearch result={search("ready")} onSearch={async () => {}} onSelect={() => {}} />);
    expect(screen.getByText("No visible memory records")).toBeVisible();
  });
});

describe("panel load states", () => {
  const conflicts = (state: string): ConflictPage => ({ schema_version: 1, resource: "memory-conflicts",
    generated_at: at, state, privacy_epoch: 0, items: [], truncated: false });
  const client = {} as MemoryClient;
  it("renders a panel that is not loaded as not loaded, never as none", () => {
    render(<><MemoryConflicts value={undefined} pending={false} />
      <MemoryCandidates value={undefined} pending={false} client={client} enabled={false}
        onReview={async () => {}} onChanged={() => {}} />
      <MemoryEffects value={undefined} pending={false} /></>);
    expect(screen.queryByText("No unresolved conflicts")).not.toBeInTheDocument();
    expect(screen.queryByText("No reviewable candidates")).not.toBeInTheDocument();
    expect(screen.queryByText(/No active/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not loaded/)).toHaveLength(3);
  });
  it("announces a panel that is reloading as busy", () => {
    render(<MemoryConflicts value={undefined} pending={true} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Loading/);
    expect(screen.queryByText(/Not loaded/)).not.toBeInTheDocument();
  });
  it("never presents an offline conflicts read as no conflicts", () => {
    render(<MemoryConflicts value={conflicts("offline")} pending={false} />);
    expect(screen.queryByText("No unresolved conflicts")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/provider offline/i);
  });
  it("keeps the plain empty state for a current read with no conflicts", () => {
    render(<MemoryConflicts value={conflicts("no_data")} pending={false} />);
    expect(screen.getByText("No unresolved conflicts")).toBeVisible();
  });
});

describe("providerState", () => {
  it("reports a stale provider read distinctly from an expired status", () => {
    expect(providerState({ ...ready, search: search("stale", ["stale"]) })).toBe("stale");
    expect(providerState({ ...ready, status: { ...ready.status!, state: "stale", mutations_enabled: false } })).toBe("expired");
  });
  it("derives offline from the latest read even when the status route is ready", () => {
    expect(providerState({ ...ready, search: search("offline", ["offline"]) })).toBe("offline");
    expect(providerState({ ...ready, conflicts: { schema_version: 1, resource: "memory-conflicts",
      generated_at: at, state: "offline", privacy_epoch: 0, items: [], truncated: false } })).toBe("offline");
    expect(providerState(ready)).toBe("ready");
    expect(providerState({ ...ready, status: { ...ready.status!, contract_schema: 3, mutations_enabled: false } })).toBe("incompatible");
  });
});

describe("MemoryEffects lifecycles", () => {
  it("lists forget and correction lifecycles beside exports", () => {
    const value: EffectPage = { schema_version: 1, resource: "memory-effects", generated_at: at, state: "ready",
      items: [
        { request_id: "memui:control:v1:forget", operation: "forget", state: "pending_approval", failure_code: null,
          updated_at: at, proof_state: "pending", export_lifecycle: null },
        { request_id: "memui:control:v1:correct", operation: "correct", state: "applying", failure_code: null,
          updated_at: at, proof_state: "pending", export_lifecycle: null },
        { request_id: "memui:control:v1:export", operation: "export", state: "completed", failure_code: null,
          updated_at: at, proof_state: "verified", export_lifecycle: null }],
      page: { limit: 20, returned: 3, has_more: true, next_cursor: null } };
    render(<MemoryEffects value={value} pending={false} />);
    const list = screen.getByRole("list", { name: "Memory effect lifecycles" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Forgetting");
    expect(rows[0]).toHaveTextContent("Pending owner approval");
    expect(rows[1]).toHaveTextContent("Correction");
    expect(rows[1]).toHaveTextContent("Approved, applying at provider");
    expect(rows[2]).toHaveTextContent("JSON export");
    expect(screen.getByText(/More lifecycles exist/)).toBeVisible();
    expect(screen.queryByText(/No active/)).not.toBeInTheDocument();
  });
});
