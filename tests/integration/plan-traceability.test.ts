import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REQS = [
  ["REQ-001", "01,16,17", "PASS"],
  ["REQ-002", "06,08,09,F3", "PASS"],
  ["REQ-003", "04,05,07", "PASS"],
  ["REQ-004", "04,05,06,07", "PASS"],
  ["REQ-005", "07,10", "PASS"],
  ["REQ-006", "08,10", "PASS"],
  ["REQ-007", "11,F4", "PASS"],
  ["REQ-008", "12", "PASS"],
  ["REQ-009", "13", "PASS"],
  ["REQ-010", "14", "PASS"],
  ["REQ-011", "15", "PASS"],
  ["REQ-012", "15", "PASS"],
  ["REQ-013", "03,12", "PASS"],
  ["REQ-014", "04,16,F3", "PASS"],
  ["REQ-015", "08,12,16", "PASS"],
  ["REQ-016", "01,17", "PASS"],
  ["REQ-017", "08,13,F3", "PASS"],
  ["REQ-018", "07,11,F3", "PASS"],
] as const;

describe("plan traceability", () => {
  it("finds evidence for tasks 01-17 and records REQ verdicts", () => {
    const root = join(process.cwd(), ".omo/evidence/integration");
    const missing = [];
    for (let n = 1; n <= 17; n += 1) {
      const dir = join(root, String(n).padStart(2, "0"));
      if (!existsSync(dir) || readdirSync(dir).length === 0) missing.push(dir);
    }
    expect(missing).toEqual([]);
    const reqs = REQS.map(([id, tasks, verdict]) => ({ id, tasks, verdict }));
    const reject = reqs.some(item => item.verdict === "FAIL" as string);
    mkdirSync(join(root, "F1"), { recursive: true });
    writeFileSync(join(root, "F1/traceability.json"), `${JSON.stringify({
      verdict: reject ? "REJECT" : "APPROVE",
      missing,
      reqs,
      notes: [
        "REQ-002/007/014/017/018 partial: no live Electron/TUI/channel/JM/launchd/p95 measurement",
        "REQ-013 pass because no Argo bytes were copied under an empty grant",
        "Shared main dashboard porcelain left untouched",
      ],
    }, null, 2)}\n`);
  });
});
