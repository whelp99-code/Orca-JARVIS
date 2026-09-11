import { JarvisError, type AuthorityDb } from "./db.js";
import type { ContextPersistenceInput } from "./personal-context-store.js";
import type { StoredContext } from "./personal-context-persistence.js";
import type { ModelTransport, ModelTransportCapture } from "./context-model-transport.js";

export class AssembledModelSession {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly transport: ModelTransport,
  ) {}

  async deliver(
    input: unknown,
    evidence: ContextPersistenceInput["memory_evidence"],
    now: string,
  ): Promise<{ stored: StoredContext; capture: ModelTransportCapture }> {
    const stored = this.authority.persistAssembledContextSnapshot(input, evidence, now);
    const capture = this.authority.lastAssembledModelCapture();
    if (capture === undefined) throw new JarvisError("MODEL_TRANSPORT_CAPTURE_MISSING");
    let result = await this.transport.send(capture);
    if (!result.accepted) result = await this.transport.send(capture);
    if (!result.accepted) throw new JarvisError("MODEL_TRANSPORT_UNAVAILABLE");
    return { stored, capture };
  }
}
