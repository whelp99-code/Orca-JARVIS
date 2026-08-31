import { describe, expect, it } from "vitest";
import { controlActionDescriptor, KNOWN_CONTROL_ACTIONS, validateControlAction } from "../../src/control-actions.js";

const digest = `sha256:${"1".repeat(64)}`;

describe("Task 30 dedicated control actions", () => {
  it("uses correction outbox plus dedicated level-3 delete and export lanes", () => {
    expect(controlActionDescriptor("memory.outbox.dispatch")).toMatchObject({ minimum_level: 3, executable: true });
    expect(controlActionDescriptor("memory.delete")).toMatchObject({ minimum_level: 3, executable: true });
    expect(controlActionDescriptor("memory.export")).toMatchObject({ minimum_level: 3, executable: true });
    expect(KNOWN_CONTROL_ACTIONS).not.toContain("memory.correct");
    expect(KNOWN_CONTROL_ACTIONS).not.toContain("memory.forget");
  });

  it.each([
    ["memory.delete", "deletion", "deletion_id", "memdel:req:v1:"],
    ["memory.export", "export", "export_id", "memexp:req:v1:"],
  ] as const)("validates %s as metadata-only authority", (action, lane, identity, prefix) => {
    const target = { [identity]: `${identity}:one`, target_manifest_digest: digest, scope_digest: digest };
    const args = { schema_version: 3, lane, lane_id: `${prefix}${"2".repeat(64)}`,
      provider_instance_id: "provider:fixture", target_manifest_digest: digest,
      scope_digest: digest, payload_digest: digest, spool_digest: digest,
      expires_at: "2026-08-31T00:10:00.000Z" };
    expect(validateControlAction({ action, action_level: 3, target, args },
      { enforceMinimumLevel: true })).toMatchObject({ action, minimum_level: 3 });
    expect(() => validateControlAction({ action, action_level: 2, target, args },
      { enforceMinimumLevel: true })).toThrow("CONTROL_ACTION_LEVEL_TOO_LOW");
    expect(JSON.stringify({ target, args })).not.toContain("content");
  });
});
