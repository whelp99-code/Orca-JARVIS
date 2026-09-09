import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PORTFOLIO_MAX_BYTES } from "../../src/dashboard/portfolio-contracts.js";
import { PORTFOLIO_STDIN_TIMEOUT_MS, readPortfolioStdin } from "../../src/dashboard/portfolio-stdin.js";

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

 it("times out incomplete input, destroys the stream and clears the timer", async () => {
  vi.useFakeTimers();
  try {
    const stream = new PassThrough();
    const pending = readPortfolioStdin(stream);
    const rejected = expect(pending).rejects.toMatchObject({code: "PORTFOLIO_INPUT_TIMEOUT"});
    stream.write(Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(PORTFOLIO_STDIN_TIMEOUT_MS);
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("clears the deadline when complete input arrives", async () => {
  vi.useFakeTimers();
  try {
    await expect(readPortfolioStdin(Readable.from([Buffer.from("complete")]))).resolves.toEqual(Buffer.from("complete"));
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
