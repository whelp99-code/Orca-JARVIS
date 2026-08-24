export type ShellWorkerSignal = {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly kind: "progress" | "completion" | "idle" | "cancel";
};

export function completionSignal(base: Omit<ShellWorkerSignal, "kind" | "sequence">, sequence: number): ShellWorkerSignal {
  return { ...base, sequence, kind: "completion" };
}
