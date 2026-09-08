import type { ChildProcess } from "node:child_process";
import { PersonalOsError } from "./personal-os-errors.js";

export const CYCLE_READY_TYPE = "personal_os_cycle_ready";

export function waitForCycleReady(child: ChildProcess, socketPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("message", message);
      child.removeListener("error", fail);
      child.removeListener("exit", fail);
    };
    const fail = (): void => { cleanup(); reject(new PersonalOsError("E_PROCESS_STRESS")); };
    const message = (value: unknown): void => {
      if (typeof value !== "object" || value === null || !("type" in value) || !("socket_path" in value)
        || value.type !== CYCLE_READY_TYPE || value.socket_path !== socketPath) return;
      cleanup(); resolve();
    };
    const timer = setTimeout(fail, timeoutMs);
    child.on("message", message); child.once("error", fail); child.once("exit", fail);
    if (child.exitCode !== null || child.signalCode !== null) fail();
  });
}
