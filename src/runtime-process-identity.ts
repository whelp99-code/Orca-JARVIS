import { readFileSync, readlinkSync } from "node:fs";

export type RuntimeProcessIncarnation = {
  readonly boot_id: string; readonly pid_namespace: string; readonly start_token: string;
};
export type RuntimeProcessObservation = {
  readonly status: "running" | "exited" | "missing" | "unavailable";
  readonly incarnation: RuntimeProcessIncarnation | null;
};
export type RuntimeProcessObserver = (pid: number) => RuntimeProcessObservation;

function statFields(pid: number | "self"): { pid: number; token: string; exited: boolean } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const token = fields[19]; const flags = Number(fields[6]);
  const observedPid = Number(stat.slice(0, stat.indexOf(" ")));
  if (close < 1 || token === undefined || !/^\d+$/.test(token) || !Number.isSafeInteger(flags) || flags < 0
    || !Number.isSafeInteger(observedPid) || observedPid < 1) throw new Error("PROCESS_OBSERVATION_INVALID");
  return { pid: observedPid, token, exited: fields[0] === "Z" || fields[0] === "X" || (flags & 0x4) !== 0 };
}
/** Only a same-PID-namespace Linux observation can establish a live incarnation. */
export const observeRuntimeProcess: RuntimeProcessObserver = pid => {
  const unavailable = { status: "unavailable" as const, incarnation: null };
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return unavailable;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = readlinkSync("/proc/self/ns/pid");
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot) || !/^pid:\[\d+\]$/.test(namespace)
      || statFields("self").pid !== process.pid) return unavailable;
    // Check this observer's proc view before classifying absence of the target.
    let before;
    try { before = statFields(pid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", incarnation: null }; throw error; }
    if (before.pid !== pid) return unavailable;
    if (readlinkSync(`/proc/${pid}/ns/pid`) !== namespace) return unavailable;
    const after = statFields(pid);
    if (before.token !== after.token || after.pid !== pid) return unavailable;
    return { status: before.exited || after.exited ? "exited" : "running", incarnation: {
      boot_id: boot, pid_namespace: namespace, start_token: after.token } };
  } catch { return unavailable; }
};
