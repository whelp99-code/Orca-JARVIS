import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ownedGroups = new Set();
const signalGroups = new Set();
const killOwned = () => {
  for (const kill of ownedGroups) kill();
};
const onInterrupt = signal => {
  // Run before a test framework's exit handler: asynchronous escalation would be lost.
  for (const kill of signalGroups) kill();
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, onInterrupt);
    process.kill(process.pid, signal);
  }
};
function registerOwner(kill, handleSignals) {
  if (ownedGroups.size === 0) process.prependListener("exit", killOwned);
  if (handleSignals && signalGroups.size === 0) {
    process.prependListener("SIGTERM", onInterrupt);
    process.prependListener("SIGINT", onInterrupt);
  }
  ownedGroups.add(kill);
  if (handleSignals) signalGroups.add(kill);
  return () => {
    ownedGroups.delete(kill);
    if (ownedGroups.size === 0) process.removeListener("exit", killOwned);
    signalGroups.delete(kill);
    if (signalGroups.size === 0) {
      process.removeListener("SIGTERM", onInterrupt);
      process.removeListener("SIGINT", onInterrupt);
    }
  };
}

/** Own one process group. Keep draining output and reap it before the caller removes scratch files. */
export async function runTestProcess(command, args, options = {}) {
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, { env: options.env ?? process.env, detached: grouped,
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "", spawnError, timedOut = false, interrupted = false, escalation;
  const send = signal => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  // A caller owning cancellation must deliver TERM before escalation so nested owners can clean up.
  const releaseOwner = registerOwner(() => send("SIGKILL"), !options.signal);
  const terminate = () => {
    send("SIGTERM");
    escalation ??= setTimeout(() => send("SIGKILL"), 1000);
  };
  const abort = () => { interrupted = true; terminate(); };
  const timeout = () => { timedOut = true; terminate(); };
  let startup = options.readyMarker ? setTimeout(timeout, options.startupTimeoutMs ?? 10000) : undefined;
  const timer = setTimeout(timeout, options.timeoutMs ?? 1200000);
  const consume = (chunk, stream) => {
    output = (output + chunk.toString("utf8")).slice(-16384);
    if (startup && output.includes(options.readyMarker)) { clearTimeout(startup); startup = undefined; }
    if (options.forward !== false) stream.write(chunk);
  };
  child.stdout.on("data", chunk => consume(chunk, process.stdout));
  child.stderr.on("data", chunk => consume(chunk, process.stderr));
  child.on("error", error => { spawnError = error.code; });
  // A grandchild retaining a pipe must not prevent close forever after the main process exits.
  child.once("exit", terminate);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(startup);
  options.signal?.removeEventListener("abort", abort);
  if (grouped && child.pid) {
    const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
    for (let i = 0; i < 20 && alive(); i++) await delay(50);
    if (alive()) { send("SIGKILL"); await delay(50); }
  }
  clearTimeout(escalation);
  releaseOwner();
  return { ...result, timedOut, interrupted, spawnError, output };
}
