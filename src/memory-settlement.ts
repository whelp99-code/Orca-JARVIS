import type Database from "better-sqlite3";
import {
  MemoryOutbox,
  type MemoryOutboxRow,
  type MemoryWriteReceipt,
  type MemoryWriteRequest,
} from "./memory-outbox.js";
import { memoryOutboxRow } from "./memory-outbox-contract.js";
import type { SecondBrainProvider } from "./second-brain-provider-contract.js";
import {
  buildSecondBrainWriteRequest,
  type MemorySettlementContext,
} from "./second-brain-write-request.js";
import { terminalDigest, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";

export type { MemorySettlementContext } from "./second-brain-write-request.js";

export type MemorySettlementOptions = Readonly<{
  source: SqlSource;
  provider: SecondBrainProvider;
  owner: string;
  clock?: () => Date;
  leaseMs?: number;
  context?: MemorySettlementContext;
}>;

export type MemorySettlementWriteResult = MemoryWriteReceipt;

const ACCEPTED_PROVIDER_STATES = new Set([
  "accepted",
  "applied",
  "forgotten",
  "exported",
  "restored",
  "settled",
]);

function dbOf(source: SqlSource): Database.Database {
  return "db" in source ? source.db : source;
}

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function leaseExpired(value: MemoryOutboxRow, now: Date): boolean {
  return value.lease_expires_at !== null
    && Date.parse(value.lease_expires_at) <= now.getTime();
}

function acceptedReceipt(
  value: Readonly<{
    status: string;
    artifact_digest?: string;
    page_id?: string;
    error_code?: string;
  }>,
): MemoryWriteReceipt {
  if (!ACCEPTED_PROVIDER_STATES.has(value.status)) {
    return value.status === "error"
      ? {
        outcome: "rejected",
        error_code: value.error_code ?? "SECOND_BRAIN_WRITE_REJECTED",
      }
      : {
        outcome: "uncertain",
        error_code: `SECOND_BRAIN_WRITE_${value.status.toUpperCase()}`,
      };
  }
  if (!value.artifact_digest || !value.page_id) {
    return {
      outcome: "uncertain",
      error_code: "SECOND_BRAIN_PROVIDER_RECEIPT_INCOMPLETE",
    };
  }
  return {
    outcome: "accepted",
    artifact_digest: value.artifact_digest,
    page_id: value.page_id,
    provider_status: value.status,
  };
}

export class MemorySettlementService {
  private readonly outbox: MemoryOutbox;
  private readonly db: Database.Database;
  private readonly clock: () => Date;
  private readonly leaseMs: number;

  constructor(private readonly options: MemorySettlementOptions) {
    this.outbox = new MemoryOutbox(options.source);
    this.db = dbOf(options.source);
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async settle(outboxId: string, now = this.clock()): Promise<MemoryOutboxRow> {
    let current = currentRow(this.db, outboxId);
    if (["settled", "rejected", "uncertain", "expired"].includes(current.state)) {
      return current;
    }
    if (current.state === "queued" || leaseExpired(current, now)) {
      current = this.outbox.claim(
        outboxId,
        this.options.owner,
        now.toISOString(),
        this.leaseMs,
      );
    } else if (current.lease_owner !== this.options.owner) {
      return current;
    }
    if (current.state === "accepted_unsettled") {
      return this.reconcile(outboxId, current.lease_fence, current, now);
    }
    if (current.state !== "delivering") return current;
    const delivered = await this.outbox.deliver(
      outboxId,
      this.options.owner,
      current.lease_fence,
      async (request) => this.write(request),
      now.toISOString(),
    );
    return delivered.state === "accepted_unsettled"
      ? this.reconcile(outboxId, delivered.lease_fence, delivered, now)
      : delivered;
  }

  async reconcile(
    outboxId: string,
    fence?: number,
    current?: MemoryOutboxRow,
    now = this.clock(),
  ): Promise<MemoryOutboxRow> {
    let local = current ?? currentRow(this.db, outboxId);
    if (!fence) return local;
    const provider = await this.options.provider.requestStatus(local.outbox_id);
    if (!provider.found) return local;
    let status = provider.status;
    let digest = provider.artifact_digest;
    let pageId = provider.page_id;
    if (status === "accepted" || !digest || !pageId) {
      const reconciled = await this.options.provider.reconcileWrite(local.outbox_id);
      status = reconciled.status;
      digest = reconciled.artifact_digest ?? digest;
      pageId = reconciled.page_id ?? pageId;
    }
    if (!local.provider_artifact_digest && digest && pageId) {
      local = this.outbox.bindRecoveredReceipt(
        outboxId,
        fence,
        {
          outcome: "accepted",
          artifact_digest: digest,
          page_id: pageId,
          provider_status: status,
        },
        now.toISOString(),
      );
    }
    const boundDigest = local.provider_artifact_digest;
    if (!boundDigest) return local;
    if (digest && digest !== boundDigest) {
      return this.outbox.reconcile(outboxId, fence, digest, now.toISOString());
    }
    digest = boundDigest;
    pageId ??= local.provider_page_id ?? undefined;
    if (status === "error" || status === "reconciling") {
      return this.outbox.markUncertain(
        outboxId,
        fence,
        `SECOND_BRAIN_PROVIDER_${status.toUpperCase()}`,
        now.toISOString(),
      );
    }
    if (status !== "settled") {
      if (!pageId) return local;
      const observed = await this.options.provider.observeArtifact(
        local.outbox_id,
        digest,
        pageId,
      );
      if (observed.status !== "settled" || observed.artifact_digest !== digest) {
        return this.outbox.markUncertain(
          outboxId,
          fence,
          "SECOND_BRAIN_ARTIFACT_NOT_SETTLED",
          now.toISOString(),
        );
      }
    }
    return this.outbox.reconcile(outboxId, fence, digest, now.toISOString());
  }

  private async write(request: MemoryWriteRequest): Promise<MemoryWriteReceipt> {
    const payload = buildSecondBrainWriteRequest(
      this.db,
      request,
      this.options.context,
    );
    try {
      return acceptedReceipt(await this.options.provider.writeRequest(payload));
    } catch (error) {
      try {
        const status = await this.options.provider.requestStatus(request.outbox_id);
        if (status.found) return acceptedReceipt(status);
      } catch {
        // The original mutation remains uncertain when status cannot be established.
      }
      return {
        outcome: "uncertain",
        error_code: error instanceof Error ? error.message : "MEMORY_SETTLEMENT_UNCERTAIN",
      };
    }
  }
}

function currentRow(db: Database.Database, outboxId: string): MemoryOutboxRow {
  const value = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(outboxId));
  if (!value) throw new Error("MEMORY_OUTBOX_NOT_FOUND");
  return memoryOutboxRow(value);
}

export const memoryWriteRequestDigest = (value: unknown): string => terminalDigest(value);
export const settlementTimestamp = (value: Date): string => timestamp(value.toISOString());
