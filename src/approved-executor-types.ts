import type { MemoryCorrectionSaga } from "./memory-correction-saga.js";
import type { MemoryDeletionSaga } from "./memory-deletion-saga.js";
import type { MemoryExportSaga } from "./memory-export-saga.js";

export type MemoryLifecycleServices = {
  readonly correction?: MemoryCorrectionSaga;
  readonly deletion?: MemoryDeletionSaga;
  readonly export?: MemoryExportSaga;
};

export interface ApprovedExecutionResult {
  request_id: string;
  action: string;
  state: "completed" | "failed" | "uncertain";
  result: unknown;
  failure_code?: string;
}
