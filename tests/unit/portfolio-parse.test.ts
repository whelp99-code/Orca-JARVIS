import { describe, expect, it } from "vitest";
import { PORTFOLIO_MAX_BYTES } from "../../src/dashboard/portfolio-contracts.js";
import { parsePortfolioIngest } from "../../src/dashboard/portfolio-parse.js";
import { collectorError, jmReport, localReport } from "../fixtures/portfolio-report.js";

function bytes(value: unknown): Buffer {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

describe("PortfolioReportV1 parsing", () => {
  it("accepts a local report with github milestones and blockers when keys are exact", () => {
    const parsed = parsePortfolioIngest(bytes(localReport()));
    expect(parsed).toEqual({ kind: "report", report: localReport() });
  });

  it("accepts a jm-server report without portfolio-wide summary keys", () => {
    const parsed = parsePortfolioIngest(bytes(jmReport()));
    expect(parsed).toEqual({ kind: "report", report: jmReport() });
  });

  it("rejects malformed JSON and non-object payloads", () => {
    for (const value of ["", "{", "[]", "null", "1", "\"x\""]) {
      expect(() => parsePortfolioIngest(bytes(value))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
    }
  });

  it("rejects oversized input when the payload exceeds 128 KiB", () => {
    const oversized = Buffer.alloc(PORTFOLIO_MAX_BYTES + 1, 0x20);
    expect(() => parsePortfolioIngest(oversized)).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
  });

  it("rejects secret-bearing string values", () => {
    for (const title of [
      "rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "rotate xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    ]) {
      const report = localReport({
        blockers: [{ title, kind: "approval_required" }],
      });
      expect(() => parsePortfolioIngest(bytes(report))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
    }
  });

  it("rejects jm-server reports that carry github milestones or blockers", () => {
    const withGithub = { ...jmReport(), github: { issue_count: 1, pull_request_count: 0 } };
    expect(() => parsePortfolioIngest(bytes(withGithub))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
  });

  it("rejects extra keys, unknown enums, and negative counts", () => {
    expect(() => parsePortfolioIngest(bytes({ ...localReport(), preview: "nope" }))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
    expect(() => parsePortfolioIngest(bytes(localReport({ milestones: [{ title: "x", state: "shipped" as "open" }] })))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
    expect(() => parsePortfolioIngest(bytes(localReport({ host: { ...localReport().host, dirty_count: -1 } })))).toThrow(expect.objectContaining({ code: "PORTFOLIO_INPUT_INVALID" }));
  });

  it("parses a collector error envelope with exact keys", () => {
    expect(parsePortfolioIngest(bytes(collectorError()))).toEqual({ kind: "error", error: collectorError() });
  });
});
