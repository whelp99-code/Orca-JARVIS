import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PORTFOLIO_MAX_BYTES } from "../../src/dashboard/portfolio-contracts.js";
import { readPortfolioStdin } from "../../src/dashboard/portfolio-stdin.js";

describe("portfolio stdin boundary", () => {
  it("preserves bounded chunks without text coercion", async () => {
    const first = Buffer.from("{\"schema_version\":", "utf8");
    const second = Buffer.from("1}", "utf8");
    await expect(readPortfolioStdin(Readable.from([first, second]))).resolves.toEqual(
      Buffer.concat([first, second]),
    );
  });

  it("rejects the first chunk that exceeds the byte ceiling", async () => {
    const stream = Readable.from([
      Buffer.alloc(PORTFOLIO_MAX_BYTES),
      Buffer.from([0x20]),
    ]);
    await expect(readPortfolioStdin(stream)).rejects.toMatchObject({
      code: "PORTFOLIO_INPUT_INVALID",
    });
  });
});
