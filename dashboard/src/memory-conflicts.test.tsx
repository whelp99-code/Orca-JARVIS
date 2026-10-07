import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryConflicts } from "./memory-conflicts.js";
import type { MemoryConflicts as ConflictPage } from "./memory-types.js";

afterEach(cleanup);

const value: ConflictPage = { schema_version: 1, resource: "memory-conflicts",
  generated_at: "2026-09-01T00:00:00.000Z", state: "ready", privacy_epoch: 4,
  items: [{ conflict_revision: `hmac-sha256:${"1".repeat(64)}`, subject: "[REDACTED]",
    state: "unresolved", sides: [
      { sensitivity: "personal", citation: "Memory citation" },
      { sensitivity: "restricted", citation: "Private citation" }] }], truncated: false };

describe("MemoryConflicts", () => {
  it("renders two metadata-only sides in source order", () => {
    render(<MemoryConflicts value={value} pending={false} />);
    expect(screen.getByRole("heading", { level: 2, name: "충돌" })).toBeVisible();
    const sides = screen.getByRole("list", { name: "Conflict sides" });
    expect(within(sides).getAllByRole("listitem")).toHaveLength(2);
    expect(within(sides).getByText("Side 1")).toBeVisible();
    expect(within(sides).getByText("Side 2")).toBeVisible();
    expect(screen.getByText("[REDACTED]")).toBeVisible();
  });

  it("does not synthesize private side text or controls", () => {
    render(<MemoryConflicts value={value} pending={false} />);
    expect(document.body.textContent).not.toContain("TASK32_PRIVATE_CANARY");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
