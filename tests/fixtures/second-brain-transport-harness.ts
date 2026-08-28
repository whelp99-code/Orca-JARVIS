import { execFile } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SecondBrainTimerHandle, SecondBrainTransportOptions } from "../../src/second-brain-transport.js";

export type Fixture = { readonly root: string; readonly launcher: string; readonly config: string; readonly control: string; readonly receipt: string };
export function fixture(settings: Readonly<Record<string, unknown>> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "second-brain-transport-")); const target = resolve("tests/fixtures/second-brain-mcp-child.mjs"); chmodSync(target, 0o755);
  const launcher = join(root, "second-brain-mcp"); const config = join(root, "config.json"); const control = join(root, "control"); const receipt = join(root, "receipt");
  closeSync(openSync(control, "w")); closeSync(openSync(receipt, "w")); symlinkSync(target, launcher); writeFileSync(config, JSON.stringify({ control, receipt, ...settings }));
  return { root, launcher, config, control, receipt };
}
type ReceiptState = { count: number; readonly waiters: Array<{ readonly count: number; readonly resolve: () => void }> };
const receipts = new Map<string, ReceiptState>(); const children = new Map<string, ReturnType<typeof execFile>>();
export function options(value: Fixture, overrides: Partial<SecondBrainTransportOptions> = {}): SecondBrainTransportOptions {
  const state: ReceiptState = { count: 0, waiters: [] }; receipts.set(value.receipt, state); const underlying = overrides.execFile ?? ((file, args, childOptions) => execFile(file, [...args], childOptions));
  return { ...overrides, launcherPath: value.launcher, configPath: value.config, execFile: (file, args, childOptions) => { const child = underlying(file, args, childOptions); children.set(value.control, child); return child; }, onDiagnostic: diagnostic => { overrides.onDiagnostic?.(diagnostic); if (diagnostic.code !== "SECOND_BRAIN_STDERR") return; state.count += 1; for (const waiter of [...state.waiters]) if (state.count >= waiter.count) { state.waiters.splice(state.waiters.indexOf(waiter), 1); waiter.resolve(); } } };
}
export async function receiptSignal(path: string, count: number): Promise<readonly Record<string, unknown>[]> {
  const state = receipts.get(path); if (!state) throw new Error("fixture receipt state missing");
  if (state.count < count) await new Promise<void>((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error("fixture receipt missing")), 2_000); state.waiters.push({ count, resolve: () => { clearTimeout(timer); resolvePromise(); } }); });
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => { const parsed: unknown = JSON.parse(line); if (!isRecord(parsed)) throw new Error("fixture receipt malformed"); return parsed; });
}
export function release(control: string): void { children.get(control)?.kill("SIGUSR1"); }
export function forceKill(control: string): void { children.get(control)?.kill("SIGKILL"); }
export function cleanupFixtures(): void { for (const path of receipts.keys()) rmSync(join(path, ".."), { force: true, recursive: true }); receipts.clear(); children.clear(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export class ManualTimers {
  readonly delays: number[] = []; private readonly callbacks = new Map<number, { readonly callback: () => void; readonly delay: number }>(); private next = 1;
  readonly set = (callback: () => void, delay: number): number => { const id = this.next; this.next += 1; this.delays.push(delay); this.callbacks.set(id, { callback, delay }); return id; };
  readonly clear = (id: SecondBrainTimerHandle): void => { if (typeof id === "number") this.callbacks.delete(id); };
  fire(delay: number): void { const found = [...this.callbacks].find(([, item]) => item.delay === delay); if (found) { this.callbacks.delete(found[0]); found[1].callback(); } }
  fireLatest(): void { const found = [...this.callbacks].at(-1); if (found) { this.callbacks.delete(found[0]); found[1].callback(); } }
  get count(): number { return this.callbacks.size; }
}
