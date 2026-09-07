import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, SecondBrainTransportError } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  cleanupFixtures();
});

describe("Second Brain transport characterization", () => {
  it.each([null, { error: { code: -32000, message: "fixture" } }])(
    "rejects an unexpected prototype key before any tool call: %j", async prototypeValue => {
      const value = fixture({ mode: "prototype-envelope", prototypeValue });
      const transport = createSecondBrainTransport(options(value));
      transports.push(transport);
      await expect(transport.call("sb_search", { query: "bounded" })).rejects.toMatchObject({
        code: "SECOND_BRAIN_MALFORMED_FRAME", disposition: "fatal",
      });
      expect(readFileSync(value.receipt, "utf8")).toBe("");
      expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_STARTED")).toHaveLength(0);
    },
  );

  it("preserves typed bounded read outcomes without mutating caller arguments", async () => {
    // Given: one supervised fixture transport and frozen caller-owned arguments.
    const value = fixture();
    const transport = createSecondBrainTransport(options(value));
    transports.push(transport);
    const arguments_ = Object.freeze({ query: "bounded", empty: true });

    // When: one current empty read and one unavailable launch are observed.
    const noData = await transport.call("sb_search", arguments_);
    const missing = fixture();
    const unavailable = createSecondBrainTransport(options(missing, { realpath: () => {
      throw new SecondBrainTransportError("SECOND_BRAIN_DISCOVERY_FAILED", "unavailable", { generation: 0 });
    } }));
    transports.push(unavailable);

    // Then: no-data and supervised errors stay distinct, bounded, and caller input is unchanged.
    expect(noData).toEqual({ kind: "no_data", reason: "empty_result" });
    await expect(unavailable.call("sb_search", { query: "bounded" })).rejects.toMatchObject({
      code: "SECOND_BRAIN_DISCOVERY_FAILED",
      disposition: "unavailable",
    });
    expect(arguments_).toEqual({ query: "bounded", empty: true });
    expect(JSON.stringify(transport.diagnostics()).length).toBeLessThan(65_536);
  });
});
