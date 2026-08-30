import {
  parseProviderHealth,
  parseProviderStatus,
  parseProviderWrite,
  type ProviderHealth,
  type ProviderJson as Json,
  type ProviderReconcileResponse,
  type ProviderRequestStatus,
  type ProviderTransportOptions,
  type ProviderWriteResponse,
  type SecondBrainProvider,
  type SecondBrainProviderMethod,
} from "./second-brain-provider-contract.js";
import { asProviderRecord } from "./second-brain-provider-codec.js";
import { SecondBrainProviderProcess } from "./second-brain-provider-process.js";

export * from "./second-brain-provider-contract.js";
export { SecondBrainProviderProcess } from "./second-brain-provider-process.js";
export {
  MemorySettlementService,
  memoryWriteRequestDigest,
  settlementTimestamp,
  type MemorySettlementContext,
  type MemorySettlementOptions,
  type MemorySettlementWriteResult,
} from "./memory-settlement.js";

export class SecondBrainProviderClient implements SecondBrainProvider {
  private readonly process: SecondBrainProviderProcess;

  constructor(options: ProviderTransportOptions = {}) {
    this.process = new SecondBrainProviderProcess(options);
  }

  async health(): Promise<ProviderHealth> {
    return parseProviderHealth(await this.process.call("sb_provider_health", {}));
  }

  async writeRequest(value: Json): Promise<ProviderWriteResponse> {
    return parseProviderWrite(await this.process.call("sb_write_request", { request: value }));
  }

  async requestStatus(requestId: string): Promise<ProviderRequestStatus> {
    return parseProviderStatus(await this.process.call(
      "sb_request_status",
      { request_id: requestId },
    ));
  }

  async reconcileWrite(
    requestId: string,
    observedDigest?: string,
  ): Promise<ProviderReconcileResponse> {
    const arguments_: Json = { request_id: requestId };
    if (observedDigest !== undefined) arguments_.observed_digest = observedDigest;
    return parseProviderWrite(await this.process.call("sb_reconcile_write", arguments_));
  }

  async restoreRequest(requestId: string): Promise<ProviderWriteResponse> {
    return parseProviderWrite(await this.process.call(
      "sb_restore_request",
      { request_id: requestId },
    ));
  }

  async observeArtifact(
    requestId: string,
    digest: string,
    pageId?: string,
  ): Promise<ProviderWriteResponse> {
    const arguments_: Json = { request_id: requestId, digest };
    if (pageId !== undefined) arguments_.page_id = pageId;
    return parseProviderWrite(await this.process.call("sb_observe_artifact", arguments_));
  }

  async exportHistory(arguments_: Json): Promise<Json> {
    return asProviderRecord(await this.process.call("sb_export_history", arguments_));
  }

  call(method: SecondBrainProviderMethod, arguments_: Json): Promise<Json> {
    return this.process.call(method, arguments_);
  }

  close(): Promise<void> {
    return this.process.close();
  }
}
