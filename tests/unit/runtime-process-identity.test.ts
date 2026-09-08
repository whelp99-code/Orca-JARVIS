import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readlinkSync } from "node:fs";
import { observeRuntimeProcess } from "../../src/runtime-process-identity.js";
vi.mock("node:fs", () => ({ readFileSync: vi.fn(), readlinkSync: vi.fn() }));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function stat(pid: number, state = "R", flags = 0, token = "1234") {
  const fields = Array<string>(20).fill("0"); fields[0] = state; fields[6] = String(flags); fields[19] = token;
  return `${pid} (name with ) spaces) ${fields.join(" ")}`;
}
beforeEach(() => {
  vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot : stat(process.pid));
  vi.mocked(readlinkSync).mockReturnValue("pid:[1234]");
});
describe.skipIf(process.platform !== "linux")("Linux daemon process incarnation", () => {
  it("binds boot, namespace, and start token around the same process", () => {
    expect(observeRuntimeProcess(process.pid)).toEqual({ status: "running", incarnation: {
      boot_id: boot, pid_namespace: "pid:[1234]", start_token: "1234" } });
  });
  it.each([["Z", 0], ["X", 0], ["R", 4], ["S", 4]] as const)("rejects exiting %s/%s even when a PID remains", (state, flags) => {
    vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot : stat(process.pid, state, flags));
    expect(observeRuntimeProcess(process.pid).status).toBe("exited");
  });
  it("rejects a proc view from another PID namespace", () => {
    vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot : stat(process.pid + 1));
    expect(observeRuntimeProcess(process.pid).status).toBe("unavailable");
  });
  it("rejects a target namespace that differs from its observer", () => {
    vi.mocked(readlinkSync).mockImplementation(path => String(path).includes("/self/") ? "pid:[1234]" : "pid:[5678]");
    expect(observeRuntimeProcess(process.pid).status).toBe("unavailable");
  });
  it.each([["Z", 0], ["R", 4]] as const)("does not attribute exited %s/%s from another namespace", (state, flags) => {
    vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot : stat(process.pid, state, flags));
    vi.mocked(readlinkSync).mockImplementation(path => String(path).includes("/self/") ? "pid:[1234]" : "pid:[5678]");
    expect(observeRuntimeProcess(process.pid)).toEqual({ status: "unavailable", incarnation: null });
  });
  it("does not attribute an exited observation across PID reuse", () => {
    let reads = 0;
    vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot
      : String(path).includes("/self/") ? stat(process.pid) : stat(process.pid, "Z", 0, String(++reads)));
    expect(observeRuntimeProcess(process.pid)).toEqual({ status: "unavailable", incarnation: null });
  });
  it("rejects PID reuse between the two process reads", () => {
    let reads = 0;
    vi.mocked(readFileSync).mockImplementation(path => String(path).endsWith("boot_id") ? boot
      : String(path).includes("/self/") ? stat(process.pid) : stat(process.pid, "R", 0, String(++reads)));
    expect(observeRuntimeProcess(process.pid).status).toBe("unavailable");
  });
  it("distinguishes missing target from denied or malformed process observation", () => {
    vi.mocked(readFileSync).mockImplementation(path => {
      if (String(path).endsWith("boot_id")) return boot;
      if (String(path).includes("/self/")) return stat(process.pid);
      throw Object.assign(new Error("PRIVATE_MARKER"), { code: "ENOENT" });
    });
    expect(observeRuntimeProcess(process.pid)).toEqual({ status: "missing", incarnation: null });
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("PRIVATE_MARKER"); });
    expect(observeRuntimeProcess(process.pid)).toEqual({ status: "unavailable", incarnation: null });
  });
});
