import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTaskExecutionClock, remainingTaskExecutionBudget, taskExecutionClockBudget } from "../../src/task-execution-clock.js";

const kernel = vi.hoisted(() => ({ boot: "00000000-1111-2222-3333-444444444444", namespace: "time:[42]", uptime: "100.00 200.00\n" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...args: any[]) => {
      if (path === "/proc/uptime") return kernel.uptime;
      if (path === "/proc/sys/kernel/random/boot_id") return kernel.boot;
      return (fs.readFileSync as any)(path, ...args);
    },
    readlinkSync: (path: Parameters<typeof fs.readlinkSync>[0], ...args: any[]) => path === "/proc/self/ns/time"
      ? kernel.namespace : (fs.readlinkSync as any)(path, ...args),
  };
});
beforeEach(() => { kernel.boot = "00000000-1111-2222-3333-444444444444"; kernel.namespace = "time:[42]"; kernel.uptime = "100.00 200.00\n"; });
afterEach(() => vi.restoreAllMocks());

describe("process-independent task execution deadline", () => {
  it("preserves the original deadline through serialization and a wall-clock rollback, subtracting the unknown tick", () => {
    const budget = taskExecutionClockBudget(1000);
    expect(remainingTaskExecutionBudget(budget)).toBe(990);
    vi.spyOn(Date, "now").mockReturnValue(-1);
    kernel.uptime = "100.50 200.00\n";
    expect(remainingTaskExecutionBudget(JSON.parse(JSON.stringify(budget)))).toBe(490);
    kernel.uptime = "100.99 200.00\n";
    expect(() => remainingTaskExecutionBudget(budget)).toThrow("TASK_EXECUTION_DEADLINE_EXCEEDED");
  });

  it.each(["boot", "namespace"])("rejects a changed %s rather than starting a new budget", dimension => {
    const budget = taskExecutionClockBudget(1000);
    if (dimension === "boot") kernel.boot = "55555555-1111-2222-3333-444444444444";
    else kernel.namespace = "time:[43]";
    expect(() => remainingTaskExecutionBudget(budget)).toThrow("TASK_EXECUTION_CLOCK_UNAVAILABLE");
  });

  it.each(["format", "negative", "precision", "overflow"])("rejects %s uptime observations", scenario => {
    kernel.uptime = { format: "bad", negative: "-1.00 0.00", precision: "100.001 0.00", overflow: "9007199254740991.00 0.00" }[scenario]!;
    expect(() => readTaskExecutionClock()).toThrow("TASK_EXECUTION_CLOCK_UNAVAILABLE");
  });

  it("rejects a deadline addition that exceeds safe integer precision", () => {
    kernel.uptime = "9007199254740.00 0.00\n";
    expect(() => taskExecutionClockBudget(600000)).toThrow("TASK_EXECUTION_CLOCK_UNAVAILABLE");
  });
});
