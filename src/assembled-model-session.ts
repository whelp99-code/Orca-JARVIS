import { JarvisError, type AuthorityDb } from "./db.js";
import type { ContextPersistenceInput } from "./personal-context-store.js";
import type { StoredContext } from "./personal-context-persistence.js";
import type { ModelTransport, ModelTransportCapture, ModelTransportResult } from "./context-model-transport.js";

export function isRetryableTransportFailure(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "retryable" in error && (error as { retryable: unknown }).retryable === true) {
    return true;
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /disconnect|ECONNRESET|UND_ERR_SOCKET|EPIPE/i.test(text);
}

export class AssembledModelSession {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly transport: ModelTransport,
    private readonly authorize: (at: Date) => void = () => undefined,
  ) {}

  async deliver(
    input: unknown,
    evidence: ContextPersistenceInput["memory_evidence"],
    now: string,
    sessionId?: string,
  ): Promise<{ stored: StoredContext; capture: ModelTransportCapture }> {
    this.authorize(new Date());
    const stored = this.authority.persistAssembledContextSnapshot(input, evidence, now, sessionId);
    const capture = this.authority.lastAssembledModelCapture();
    if (capture === undefined) throw new JarvisError("MODEL_TRANSPORT_CAPTURE_MISSING");
    let result = await this.sendOnce(capture);
    if (!result.accepted) {
      this.authorize(new Date());
      result = await this.sendOnce(capture);
    }
    if (!result.accepted) throw new JarvisError("MODEL_TRANSPORT_UNAVAILABLE");
    return { stored, capture };
  }

  private async sendOnce(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    try {
      return await this.transport.send(capture);
    } catch (error) {
      if (!isRetryableTransportFailure(error)) throw error;
      return { accepted: false, reason: "disconnect" };
    }
  }
}
