import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeControlFrame, encodeControlFrame } from "../../src/jarvis/control-protocol-codec.js";

describe("cli-jaw jarvis-control codec", () => {
  it("parses the shared capabilities fixture", () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/control-protocol/v1/capabilities-get.json"), "utf8"));
    const decoded = decodeControlFrame(encodeControlFrame(fixture));
    expect(decoded).toEqual({ ok: true, frame: fixture });
  });
});
