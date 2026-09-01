import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePersonalOsPolicy, PersonalPolicyError } from "../../src/personal-os-policy.js";
import {
  FROZEN_REMOTE_APPROVAL_POLICY,
  parseRemoteApprovalPolicy,
  RemoteApprovalPolicyError,
} from "../../src/remote-approval-policy.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("remote approval closed policy", () => {
  it("parses the shipped remote_approval block as the frozen object", () => {
    const value: unknown = JSON.parse(readFileSync("config/personal-os-policy.json", "utf8"));
    const policy = parsePersonalOsPolicy(value);
    expect(policy.remote_approval).toEqual(FROZEN_REMOTE_APPROVAL_POLICY);
  });

  it.each([
    ["missing key", (value: Record<string, unknown>) => { delete value.max_action_level; }],
    ["unknown key", (value: Record<string, unknown>) => { value.safe_subset = true; }],
    ["wrong level", (value: Record<string, unknown>) => { value.max_action_level = 4; }],
    ["extra action", (value: Record<string, unknown>) => {
      value.allowed_actions = [...FROZEN_REMOTE_APPROVAL_POLICY.allowed_actions, "git.push"];
    }],
    ["missing action", (value: Record<string, unknown>) => {
      value.allowed_actions = FROZEN_REMOTE_APPROVAL_POLICY.allowed_actions.slice(1);
    }],
    ["ttl n-1", (value: Record<string, unknown>) => { value.challenge_ttl_seconds = 299; }],
    ["ttl n+1", (value: Record<string, unknown>) => { value.challenge_ttl_seconds = 301; }],
    ["wrong enum", (value: Record<string, unknown>) => { value.counter_regression_policy = "compromise"; }],
  ])("rejects %s before bind", (_name, mutate) => {
    const value = { ...FROZEN_REMOTE_APPROVAL_POLICY } as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => parseRemoteApprovalPolicy(value)).toThrow(RemoteApprovalPolicyError);
  });

  it("rejects a shipped policy that omits remote_approval", () => {
    const value = JSON.parse(readFileSync("config/personal-os-policy.json", "utf8")) as unknown;
    if (!isObject(value)) throw new TypeError("policy");
    delete value.remote_approval;
    expect(() => parsePersonalOsPolicy(value)).toThrow(PersonalPolicyError);
  });
});
