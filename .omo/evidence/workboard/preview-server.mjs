// Evidence-only preview: the isolated e2e fixture server plus test-only workboard rows.
// Never points at the production authority database.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { startDashboardFixture } from "../../../dist/tests/fixtures/dashboard-fixture-runtime.js";
import { seedWorkboardFixture } from "../../../dist/tests/fixtures/workboard-fixture.js";

const port = Number(process.env.WORKBOARD_PREVIEW_PORT ?? "4180");
const fixture = await startDashboardFixture({
  host: "127.0.0.1",
  port,
  staticRoot: resolve("dist/dashboard"),
  metadataPath: resolve(".omo/evidence/workboard/preview-metadata.json"),
  seed: true,
});
seedWorkboardFixture(fixture.env.db.db);
process.stdout.write(`READY ${fixture.metadata.url}/workboard\n`);

const shutdown = () => {
  try { fixture.close(); } catch { /* already closed */ }
  rmSync(fixture.env.tempRoot, { recursive: true, force: true });
  rmSync(resolve(".omo/evidence/workboard/preview-metadata.json"), { force: true });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
