import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { request } from "undici";

/**
 * Launches the in-repo Task 32 Memory fixture (`tests/fixtures/memory-surface-fixture.ts`, compiled
 * to `dist/`) on ephemeral loopback ports and drives its owner/provider control endpoints.
 * Every spec owns its own fixture; nothing touches production ports or state.
 */
export type ProviderMode = "current" | "offline" | "unavailable" | "no_data" | "stale";
export class MemorySurfaceFixture {
  private constructor(readonly app: string, readonly ctl: string, private readonly child: ChildProcess) {}

  static async start(): Promise<MemorySurfaceFixture> {
    const child = spawn(process.execPath, [resolve("dist/tests/fixtures/memory-surface-fixture.js"),
      "--static-root", resolve("dist/dashboard")], { stdio: ["ignore", "pipe", "inherit"] });
    if (child.stdout === null) throw new Error("fixture stdout");
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise<{ app: string; ctl: string }>((done, fail) => {
      lines.once("line", line => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "ready") !== true) {
          fail(new Error(`fixture not ready: ${line}`)); return;
        }
        done({ app: String(Reflect.get(parsed, "app")), ctl: String(Reflect.get(parsed, "ctl")) });
      });
      child.once("exit", code => { fail(new Error(`fixture exited early: ${String(code)}`)); });
    });
    const { app, ctl } = await ready;
    return new MemorySurfaceFixture(app, ctl, child);
  }

  /** Server time now; install the page clock here so freshness windows agree with the fixture. */
  async now(): Promise<number> {
    const value = await this.control("/now");
    return Date.parse(String(typeof value === "object" && value !== null ? Reflect.get(value, "now") : ""));
  }
  async control(path: string): Promise<unknown> {
    const response = await request(`${this.ctl}${path}`);
    const body: unknown = JSON.parse(await response.body.text());
    if (response.statusCode !== 200) throw new Error(`control ${path}: ${String(response.statusCode)}`);
    return body;
  }
  mode(value: ProviderMode): Promise<unknown> { return this.control(`/mode?value=${value}`); }
  approve(): Promise<unknown> { return this.control("/approve"); }
  applyCorrection(text: string): Promise<unknown> {
    return this.control(`/provider-apply-correction?text=${encodeURIComponent(text)}`);
  }
  async commands(): Promise<ReadonlyArray<{ action: string; state: string; n: number }>> {
    const state = await this.control("/state");
    const commands = typeof state === "object" && state !== null ? Reflect.get(state, "commands") : undefined;
    return Array.isArray(commands) ? commands as Array<{ action: string; state: string; n: number }> : [];
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}
