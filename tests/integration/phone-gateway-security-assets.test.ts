import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionGatewayFixture } from "../fixtures/remote-approval-gateway-harness.js";

let buildRoot = "";

beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "jarvis-dashboard-build-"));
  execFileSync(process.execPath, [
    resolve("node_modules/vite/bin/vite.js"), "build", "--config", "dashboard/vite.config.ts", "--outDir", buildRoot, "--logLevel", "error",
  ], { stdio: "pipe" });
});

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

function referencedAssets(html: string): { readonly script: string; readonly css: string } {
  const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const css = /<link[^>]+href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  if (script === undefined || css === undefined) throw new Error(`index.html references: ${html}`);
  return { script, css };
}

describe("phone gateway serves the shipped security page", () => {
  it("serves /security and the JS/CSS its index.html references from a real vite build", async () => {
    const fixture = await ProductionGatewayFixture.start({ staticRoot: buildRoot });
    try {
      const page = await fixture.gatewayRaw("/security");
      expect(page.status).toBe(200);
      expect(page.type).toContain("text/html");
      expect(page.text).toContain("jarvis-phone-mode");
      const assets = referencedAssets(page.text);

      const script = await fixture.gatewayRaw(assets.script);
      expect(script.status).toBe(200);
      expect(script.type).toBe("text/javascript; charset=utf-8");
      expect(script.text).toBe(readFileSync(join(buildRoot, assets.script.slice(1)), "utf8"));

      const css = await fixture.gatewayRaw(assets.css);
      expect(css.status).toBe(200);
      expect(css.type).toBe("text/css; charset=utf-8");
      expect(css.text).toBe(readFileSync(join(buildRoot, assets.css.slice(1)), "utf8"));
    } finally {
      fixture.close();
    }
  });

  it("still refuses an asset name the manifest does not list", async () => {
    const fixture = await ProductionGatewayFixture.start({ staticRoot: buildRoot });
    try {
      const missing = await fixture.gatewayRaw("/assets/index-unlisted.js");
      expect(missing.status).toBe(404);
    } finally {
      fixture.close();
    }
  });
});
