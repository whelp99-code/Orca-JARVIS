import { Readable } from "node:stream";
import { JarvisError } from "../db.js";
import { PORTFOLIO_MAX_BYTES } from "./portfolio-contracts.js";

export const PORTFOLIO_STDIN_TIMEOUT_MS = 60_000;

export async function readPortfolioStdin(stream: Readable = process.stdin): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = setTimeout(() => {
    stream.destroy(new JarvisError("PORTFOLIO_INPUT_TIMEOUT"));
  }, PORTFOLIO_STDIN_TIMEOUT_MS);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      total += bytes.byteLength;
      if (total > PORTFOLIO_MAX_BYTES) throw new JarvisError("PORTFOLIO_INPUT_INVALID");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(deadline);
  }
}
