export function runTestProcess(command: string, args: readonly string[], options?: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number; startupTimeoutMs?: number; readyMarker?: string;
  forward?: boolean; signal?: AbortSignal;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  interrupted: boolean; spawnError?: string; output: string }>;
