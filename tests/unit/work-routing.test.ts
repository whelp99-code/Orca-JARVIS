import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyWorkRouting } from "../../src/work-routing.js";

const policy = () => JSON.parse(readFileSync("config/work-routing.preview.json", "utf8"));
const request = (objective: string) => ({ schema_version: 1, objective });

describe("versioned work routing preview", () => {
  it.each([
    ["Orca-JARVIS 오류 수정", "code"], ["/home/jm/orca/projects/example 수정", "code"],
    ["메일 회신 초안", "mail"], ["sAnGfOr HCI 검토", "sangfor"], ["견적서 docx 작성", "document"],
  ])("classifies %s and explains its configured matches", (objective, id) => {
    const result = classifyWorkRouting(request(objective!), policy());
    expect(result).toMatchObject({ status: "classified", reason: "single_rule_match", executable: false, readiness: "not_probed" });
    expect(result.matches.map(match => match.rule_id)).toEqual([id]);
    expect(result.matches[0]!.matched_keywords.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("objective");
  });

  it("requires review for the draft's Sangfor document exception instead of inventing precedence", () => {
    const result = classifyWorkRouting(request("Sangfor 견적서"), policy());
    expect(result).toMatchObject({ status: "needs_review", reason: "multiple_rule_matches", executable: false });
    expect(result.matches.map(match => match.rule_id)).toEqual(["sangfor", "document"]);
  });

  it("preserves non-ASCII literal matching instead of context-sensitive lowercasing", () => {
    const value = policy(); value.rules = [{ id: "literal", keywords: ["ΟΣ"], executor_ids: ["reviewer"], record_stores: ["local"] }];
    expect(classifyWorkRouting(request("ΟΣΑ"), value).status).toBe("classified");
    expect(classifyWorkRouting(request("οσα"), value).status).toBe("needs_review");
  });

  it.each(["이번 주 일정 확인", "switching ADESKTOP prefixNGAFsuffix"])("does not match incidental ASCII text %s", objective => {
    const result = classifyWorkRouting(request(objective), policy());
    expect(result).toMatchObject({ status: "needs_review", reason: "no_rule_match", matches: [] });
  });

  it("binds request, policy revision and executor changes into deterministic decisions", () => {
    const input = request("메일 회신 초안"); const base = policy();
    const original = classifyWorkRouting(input, base);
    expect(classifyWorkRouting(input, structuredClone(base))).toEqual(original);
    expect(classifyWorkRouting(request("메일 회신 검토"), base).decision_digest).not.toBe(original.decision_digest);
    base.revision++;
    expect(classifyWorkRouting(input, base).policy_digest).not.toBe(original.policy_digest);
    base.rules[1].executor_ids = ["different-executor"];
    expect(classifyWorkRouting(input, base).decision_digest).not.toBe(original.decision_digest);
  });

  it.each([
    { schema_version: 2, objective: "메일" }, { schema_version: 1, objective: "메일", execute: true },
    { schema_version: 1, objective: "x".repeat(4097) }, { schema_version: 1, objective: "메일\u0000" },
  ])("rejects invalid request %j", value => {
    expect(() => classifyWorkRouting(value, policy())).toThrow("WORK_ROUTING_INPUT_INVALID");
  });

  it.each(["version", "duplicate-rule", "duplicate-keyword", "oversize", "command", "revision"])("rejects invalid policy %s", mode => {
    const value = policy();
    if (mode === "version") value.schema_version = 2;
    if (mode === "duplicate-rule") value.rules.push(value.rules[0]);
    if (mode === "duplicate-keyword") value.rules[0].keywords = ["repo", "REPO"];
    if (mode === "oversize") value.rules[0].keywords = ["x".repeat(129)];
    if (mode === "command") value.rules[0].command = "execute";
    if (mode === "revision") value.revision = 0;
    expect(() => classifyWorkRouting(request("메일"), value)).toThrow("WORK_ROUTING_INPUT_INVALID");
  });
});
