import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { createDashboardServer } from "../../src/dashboard/server.js";

const originOf = (address: { readonly family: "IPv4"; readonly host: string; readonly port: number }): string =>
  `http://${address.host}:${address.port}`;

describe("dashboard static assets", () => {
  it("serves built assets with exact content and never falls back for asset misses or traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-assets-"));
    const staticRoot = join(root, "static");
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    writeFileSync(join(staticRoot, "assets", "app.js"), "globalThis.__JCC__ = true;", "utf8");
    writeFileSync(join(staticRoot, "assets", "app.css"), ":root{color:#111}", "utf8");
    const db = new AuthorityDb(join(root, "jarvis.sqlite"));
    await db.migrate();
    const server = createDashboardServer({ db, staticRoot, host: "127.0.0.1", port: 0 });
    const origin = originOf(server.address);
    try {
      const script = await request(`${origin}/assets/app.js`);
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(await script.body.text()).toBe("globalThis.__JCC__ = true;");

      const style = await request(`${origin}/assets/app.css`);
      expect(style.statusCode).toBe(200);
      expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(await style.body.text()).toBe(":root{color:#111}");

      const missing = await request(`${origin}/assets/missing.js`);
      expect(missing.statusCode).toBe(404);
      expect(await missing.body.text()).not.toContain("id=\"root\"");

      const traversal = await request(`${origin}/assets/%2e%2e/package.json`);
      expect(traversal.statusCode).toBe(404);
      expect(await traversal.body.text()).not.toContain("packageManager");
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
