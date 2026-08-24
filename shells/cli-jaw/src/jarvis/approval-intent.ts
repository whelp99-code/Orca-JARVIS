export const SHELL_APPROVAL_STATUSES = ["displayed", "denied", "queued_local", "refused"] as const;
export type ShellApprovalStatus = (typeof SHELL_APPROVAL_STATUSES)[number];

export type ShellApprovalRecord = {
  readonly intentId: string;
  readonly requestId: string;
  readonly displayExpiry: string;
  readonly generation: string;
  readonly status: ShellApprovalStatus;
};

export type ApprovalCallbackBinding = {
  readonly intentId: string;
  readonly channel: string;
  readonly account: string;
  readonly sender: string;
  readonly thread: string;
  readonly message: string;
  readonly generation: string;
};

export type ApprovalCallback = ApprovalCallbackBinding & {
  readonly action: "deny" | "queue_local" | "approve";
};

export type CallbackResult = {
  readonly status: ShellApprovalStatus;
  readonly code?: string;
};

const FORBIDDEN_SHELL_KEYS = ["signature", "command_digest", "commandDigest", "signingKey", "receipt"] as const;

export function assertShellSafeRecord(record: Readonly<Record<string, unknown>>): void {
  for (const key of FORBIDDEN_SHELL_KEYS) {
    if (key in record) throw new Error("SHELL_APPROVAL_SECRET_FORBIDDEN");
  }
}

export class ShellApprovalStore {
  private readonly records = new Map<string, ShellApprovalRecord>();
  private readonly bindings = new Map<string, ApprovalCallbackBinding>();
  private queueingEnabled = true;

  present(record: ShellApprovalRecord): ShellApprovalRecord {
    assertShellSafeRecord(record);
    const stored: ShellApprovalRecord = {
      intentId: record.intentId,
      requestId: record.requestId,
      displayExpiry: record.displayExpiry,
      generation: record.generation,
      status: "displayed",
    };
    this.records.set(record.intentId, stored);
    return stored;
  }

  bindCallback(binding: ApprovalCallbackBinding): void {
    if (!this.records.has(binding.intentId)) throw new Error("SHELL_APPROVAL_UNKNOWN_INTENT");
    this.bindings.set(binding.intentId, binding);
  }

  setQueueingEnabled(enabled: boolean): void {
    this.queueingEnabled = enabled;
  }

  snapshot(): readonly ShellApprovalRecord[] {
    return [...this.records.values()];
  }

  resolveCallback(callback: ApprovalCallback, now = new Date()): CallbackResult {
    const record = this.records.get(callback.intentId);
    const binding = this.bindings.get(callback.intentId);
    if (!record || !binding) return this.refuse(callback.intentId, "SHELL_CALLBACK_UNKNOWN");
    if (Date.parse(record.displayExpiry) <= now.getTime()) return this.refuse(callback.intentId, "SHELL_CALLBACK_EXPIRED");
    if (callback.generation !== record.generation || callback.generation !== binding.generation) {
      return this.refuse(callback.intentId, "SHELL_CALLBACK_GENERATION");
    }
    if (
      callback.channel !== binding.channel
      || callback.account !== binding.account
      || callback.sender !== binding.sender
      || callback.thread !== binding.thread
      || callback.message !== binding.message
    ) {
      return this.refuse(callback.intentId, "SHELL_CALLBACK_BINDING");
    }
    if (callback.action === "approve") return this.refuse(callback.intentId, "SHELL_REMOTE_APPROVE_FORBIDDEN");
    if (callback.action === "queue_local") {
      if (!this.queueingEnabled) return this.refuse(callback.intentId, "SHELL_QUEUEING_DISABLED");
      const queued = { ...record, status: "queued_local" as const };
      this.records.set(record.intentId, queued);
      return { status: queued.status };
    }
    const denied = { ...record, status: "denied" as const };
    this.records.set(record.intentId, denied);
    return { status: denied.status };
  }

  private refuse(intentId: string, code: string): CallbackResult {
    const current = this.records.get(intentId);
    if (current) this.records.set(intentId, { ...current, status: "refused" });
    return { status: "refused", code };
  }
}
