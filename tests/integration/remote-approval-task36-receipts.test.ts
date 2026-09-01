import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("task 35 does not claim task 36 v4 credit", () => {
  it("keeps product sources free of the historical mixed task-36 artifact hash", () => {
    const source = readFileSync("src/remote-approval.ts", "utf8");
    expect(source.includes("dd14cc78a4a35fde931e4dde0bda1f46dc584429a6557eae58586fb86257303f")).toBe(false);
    expect(source.includes("ControlPlane")).toBe(true);
  });
});
