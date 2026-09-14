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

  async prepare(
    input: unknown,
    evidence: ContextPersistenceInput["memory_evidence"],
    now: string,
    sessionId?: string,
  ): Promise<{ stored: StoredContext; capture: ModelTransportCapture }> {
    this.authorize(new Date());
    const stored = this.authority.persistAssembledContextSnapshot(input, evidence, now, sessionId);
    const capture = this.authority.lastAssembledModelCapture();
    if (capture === undefined) throw new JarvisError("MODEL_TRANSPORT_CAPTURE_MISSING");
    return { stored, capture };
  }

  async send(
    capture: ModelTransportCapture,
    hooks: { beginAttempt?: () => void; onKnownNegative?: () => void; beforeSend?: () => Promise<void> | void } = {},
  ): Promise<ModelTransportResult> {
    await hooks.beforeSend?.();
    hooks.beginAttempt?.();
    let result = await this.transport.send(capture);
    if (result.accepted) return result;
    const firstClass = result.failure_class;
    if (firstClass === "unknown") {
      throw new JarvisError("MODEL_TRANSPORT_UNKNOWN");
    }
    if (firstClass !== "known_not_sent") {
      hooks.onKnownNegative?.();
    }
    this.authorize(new Date());
    await hooks.beforeSend?.();
    hooks.beginAttempt?.();
    result = await this.transport.send(capture);
    if (result.accepted) return result;
    if (result.failure_class === "unknown") {
      throw new JarvisError("MODEL_TRANSPORT_UNKNOWN");
    }
    if (result.failure_class !== "known_not_sent") {
      hooks.onKnownNegative?.();
    }
    throw new JarvisError("MODEL_TRANSPORT_UNAVAILABLE");
  }

  async deliver(
    input: unknown,
    evidence: ContextPersistenceInput["memory_evidence"],
    now: string,
    sessionId?: string,
  ): Promise<{ stored: StoredContext; capture: ModelTransportCapture }> {
    const prepared = await this.prepare(input, evidence, now, sessionId);
    await this.send(prepared.capture);
    return prepared;
  }
}
