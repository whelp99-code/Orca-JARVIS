import { resolve } from "node:path";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "./second-brain-transport-harness.js";

export async function correctedCitationRead(cited: boolean) {
  const value = fixture({ contractPath: resolve("contracts/second-brain-mcp-v1.json"),
    adapterScenario: "corrected", emptyResponse: { method: "sb_read_page", value: {
      frontmatter: { id: "wiki/principle", title: "synthetic", updated: "2026-08-28",
        compiled_by: "sb/fixture|prompt-v1|model-v1", status: "active", sources: "" },
      body: cited ? "corrected-7391[^a1b2c3d4]\n\n[^a1b2c3d4]: fixture:correction\n"
        : "corrected-7391\n\n[^a1b2c3d4]: fixture:correction\n",
    } } });
  const transport = createSecondBrainTransport(options(value));
  const reader = createSecondBrainReadAdapter({ transport, contract_profile: "schema3-read-only",
    budgets: { max_hits: 2, max_excerpt_bytes: 512, max_total_bytes: 4096, max_page_bytes: 4096 },
    clock: () => new Date("2026-08-28T12:00:00.000Z"), max_age_ms: 86_400_000, expiry_ms: 172_800_000 });
  try { return await reader.search("corrected-7391"); }
  finally { await transport.close(); cleanupFixtures(); }
}
