import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { execute } from "../../src/cli.js";
import { servePersonalOsCycleChannel } from "../../src/personal-os-cycle-channel.js";
import { tempDb } from "../helpers.js";
vi.mock("../../src/personal-os-cycle-channel.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/personal-os-cycle-channel.js")>(),
  servePersonalOsCycleChannel: vi.fn(async () => undefined),
}));
describe("staged-execstart identity boundary", () => {
  it("does not publish or acquire a GJC daemon identity for the rehearsal channel", async () => {
    const filename = tempDb(); const db = new AuthorityDb(filename); await db.migrate();
    vi.stubEnv("PERSONAL_OS_CONTROL_CHANNEL", join(dirname(filename), "fixture.sock"));
    try {
      expect(await execute(["service", "run", "--db", filename])).toMatchObject({
        ok: true, command: "service.run", runtime_surface: "staged-execstart" });
      expect(servePersonalOsCycleChannel).toHaveBeenCalledOnce();
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_runtime_identity").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_runtime_leases").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_runtime_status").get()).toEqual({ n: 0 });
    } finally { vi.unstubAllEnvs(); db.close(); rmSync(dirname(filename), { recursive: true, force: true }); }
  });
});
