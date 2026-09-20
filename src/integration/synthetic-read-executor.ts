import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../jarvis-error.js";
import { Core5CapabilityRegistry } from "./capability-registry.js";
import { applyCancellation, type ExternalEffectWindow } from "./cancellation.js";
import { Core5OperationLedger } from "./operation-ledger.js";
import { parseCommandEnvelope } from "./schema.js";
import type { CommandEnvelope, ExecutionResult } from "./types.js";

/** Read-only reference executor. Proves contract extension; never Mail send / CRM mutate / SB write. */
export class SyntheticReadOnlyExecutor {
  constructor(
    private readonly registry: Core5CapabilityRegistry,
    private readonly ledger: Core5OperationLedger,
  ) {}

  execute(raw: unknown): ExecutionResult {
    const envelope = parseCommandEnvelope(raw);
    this.assertReadOnly(envelope);
    this.registry.requireEnabled(envelope.capability);
    this.ledger.schedule(envelope);
    const digest = "sha256:" + createHash("sha256").update(canonicalize({
      operation_id: envelope.operation_id,
      capability: envelope.capability,
      payload: envelope.payload,
    })).digest("hex");
    const result: ExecutionResult = {
      schema_version: 1,
      operation_id: envelope.operation_id,
      attempt_id: envelope.attempt_id,
      lease_fence: envelope.lease_fence,
      status: "SUCCESS",
      evidence_refs: [{ kind: "synthetic_read", digest }],
    };
    this.ledger.recordResult(result);
    return result;
  }

  cancel(raw: unknown, window: ExternalEffectWindow): ExecutionResult {
    const envelope = parseCommandEnvelope(raw);
    this.assertReadOnly(envelope);
    this.registry.requireEnabled(envelope.capability);
    const existing = this.ledger.get(envelope.operation_id);
    if (existing === undefined) this.ledger.schedule(envelope);
    const decision = applyCancellation({ status: "UNCERTAIN" }, window);
    const result: ExecutionResult = {
      schema_version: 1,
      operation_id: envelope.operation_id,
      attempt_id: envelope.attempt_id,
      lease_fence: envelope.lease_fence,
      status: decision.status,
    };
    this.ledger.recordResult(result);
    return result;
  }

  private assertReadOnly(envelope: CommandEnvelope): void {
    if (!envelope.capability.endsWith(".read") && envelope.capability !== "mail.status"
      && envelope.capability !== "cwos.state" && envelope.capability !== "memory.status") {
      throw new JarvisError("CORE5_SYNTHETIC_READ_ONLY", envelope.capability);
    }
  }
}
