import { type LiveBinding, type LiveObservation } from "./live-supervisor.js";
import { OrcaReadonlyAdapter, defaultRunner, type OrcaRunner, type OrcaTerminal } from "./orca.js";
import { createOrcaRunner, decodeEnvWorktree } from "./orca-env.js";
import { isTransientOrcaReadFailure } from "./orca-read-envelope.js";

export async function readBoundObservation(binding: LiveBinding, runner?: OrcaRunner): Promise<readonly LiveObservation[]> {
  const decoded = decodeEnvWorktree(binding.canonical_path);
  const envRunner = createOrcaRunner(decoded.environment, runner ?? defaultRunner);
  const adapter = new OrcaReadonlyAdapter(envRunner);
  const terminals: OrcaTerminal[] = await adapter.list(decoded.listSelector);
  const terminal = terminals.find(item => item.handle === binding.terminal_id
    && item.incarnationId === binding.incarnation_id
    && item.ptyId === binding.pty_id
    && item.worktreeId === binding.worktree_id);
  if (!terminal) return [unknownObservation(binding)];
  if (!terminal.connected) return [{ ...unknownObservation(binding), connected: false }];
  const read = await adapter.read(binding.terminal_id, binding.cursor, 1);
  if (read.handle !== binding.terminal_id || !["ok", "running"].includes(read.status)) return [unknownObservation(binding)];
  return [{ ...unknownObservation(binding), cursor: read.nextCursor, connected: true }];
}

export async function observeBound(binding: LiveBinding, runner?: OrcaRunner): Promise<readonly LiveObservation[]> {
  try { return await readBoundObservation(binding, runner); }
  catch (error) { if (isTransientOrcaReadFailure(error)) return [unknownObservation(binding)]; throw error; }
}

export function unknownObservation(binding: LiveBinding): LiveObservation {
  return {
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    session_id: binding.session_id,
    incarnation_id: binding.incarnation_id,
    cursor: binding.cursor,
    state: "unknown",
  };
}

