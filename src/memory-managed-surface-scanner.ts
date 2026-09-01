import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { loadForbiddenContentIdentities,
  type ForbiddenContentIdentity } from "./memory-forbidden-content.js";
import type {
  CompleteProviderSurfaceInventory,
  CompleteReingressGuardObservations,
} from "./memory-lifecycle-observation-manifest.js";
import {
  MEMORY_MANAGED_SURFACE_CATALOG,
  MEMORY_MANAGED_SURFACE_CATALOG_DIGEST,
} from "./memory-managed-surface-catalog.js";
import { scanFilesystemSurface } from "./memory-managed-surface-files.js";
import { scanSqliteSurface } from "./memory-managed-surface-sqlite.js";
import {
  CompleteMemorySurfaceInventory,
  type ManagedSurfaceDefinition,
  type MemoryManagedSurfaceEntry,
} from "./memory-managed-surface-types.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update(canonicalize(value)).digest("hex")}`;

export type MemoryRuntimeLayout = {
  readonly spool_root: string;
  readonly state_root: string;
  readonly dist_root: string;
  readonly backup_root: string;
  readonly restore_root: string;
};

type ScannerOptions = {
  readonly authority: AuthorityDb;
  readonly layout: MemoryRuntimeLayout;
};

type ScanInput = {
  readonly provider: CompleteProviderSurfaceInventory;
  readonly guards: CompleteReingressGuardObservations;
};

class CompleteInventoryRecord extends CompleteMemorySurfaceInventory {
  readonly catalog_digest = MEMORY_MANAGED_SURFACE_CATALOG_DIGEST;
  readonly expected_surface_count = 70 as const;

  constructor(
    readonly manifest_digest: string,
    readonly entries: readonly MemoryManagedSurfaceEntry[],
    readonly observed_surface_count: 70,
    readonly omission_count: 0,
    readonly error_count: 0,
    readonly match_count: 0,
  ) {
    super();
  }
}

export class MemoryManagedSurfaceScanner {
  constructor(private readonly options: ScannerOptions) {}

  async scan(input: ScanInput): Promise<CompleteMemorySurfaceInventory> {
    if (!Array.isArray(input.provider.entries) || input.provider.entries.length !== 40
      || !Array.isArray(input.guards.entries) || input.guards.entries.length !== 10) {
      throw new JarvisError("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
    }
    const identities = loadForbiddenContentIdentities(this.options.authority);
    const entries = MEMORY_MANAGED_SURFACE_CATALOG.map(definition =>
      this.scanDefinition(definition, input, identities));
    const omissionCount = entries.reduce((total, entry) => total + entry.omission_count, 0);
    const errorCount = entries.reduce((total, entry) => total + entry.error_count, 0);
    const matchCount = entries.reduce((total, entry) => total + entry.match_count, 0);
    if (entries.length !== 70 || omissionCount !== 0 || errorCount !== 0 || matchCount !== 0) {
      throw new JarvisError("MEMORY_SURFACE_INVENTORY_INCOMPLETE");
    }
    return new CompleteInventoryRecord(digest({
      catalog_digest: MEMORY_MANAGED_SURFACE_CATALOG_DIGEST, entries,
    }), Object.freeze(entries), exactSurfaceCount(entries.length), exactZero(omissionCount),
    exactZero(errorCount), exactZero(matchCount));
  }

  private scanDefinition(
    definition: ManagedSurfaceDefinition,
    input: ScanInput,
    identities: readonly ForbiddenContentIdentity[],
  ): MemoryManagedSurfaceEntry {
    switch (definition.scanner_kind) {
      case "provider_manifest":
        return this.providerEntry(definition, input.provider);
      case "filesystem":
        return this.filesystemEntry(definition, identities);
      case "sqlite": case "proc_fd":
        return scanSqliteSurface({ authority: this.options.authority, definition,
          prefixes: SQLITE_SURFACE_PREFIXES[definition.surface_id] ?? [], identities });
      case "guard":
        return this.guardEntry(definition, input.guards);
      default:
        return assertNever(definition.scanner_kind);
    }
  }

  private providerEntry(
    definition: ManagedSurfaceDefinition,
    provider: CompleteProviderSurfaceInventory,
  ): MemoryManagedSurfaceEntry {
    const observed = provider.entries.find(entry => entry.catalog_key === definition.catalog_key);
    if (observed === undefined || observed.owner !== definition.owner
      || observed.surface_id !== definition.surface_id
      || !observed.readable || observed.error_count !== 0
      || observed.omission_count !== 0 || observed.match_count !== 0
      || observed.errors.length !== 0) {
      throw new JarvisError("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
    }
    return { ...definition, applicable: observed.applicable, readable: observed.readable,
      manifest_digest: observed.manifest_digest, file_count: observed.file_count,
      row_count: observed.row_count, object_count: observed.object_count,
      fd_count: observed.fd_count, match_count: observed.match_count,
      error_count: observed.error_count, omission_count: observed.omission_count,
      scan_digest: observed.scan_digest };
  }

  private filesystemEntry(
    definition: ManagedSurfaceDefinition,
    identities: readonly ForbiddenContentIdentity[],
  ): MemoryManagedSurfaceEntry {
    const scan = scanFilesystemSurface(this.localRoot(definition.surface_id), identities,
      definition.surface_id === "dist_runtime_fixtures");
    return { ...definition, applicable: true, readable: scan.readable,
      manifest_digest: scan.manifest_digest, file_count: scan.file_count,
      row_count: 0, object_count: scan.object_count, fd_count: 0,
      match_count: scan.match_count, error_count: scan.error_count,
      omission_count: scan.omission_count, scan_digest: scan.scan_digest };
  }

  private guardEntry(
    definition: ManagedSurfaceDefinition,
    guards: CompleteReingressGuardObservations,
  ): MemoryManagedSurfaceEntry {
    const observed = guards.entries.find(entry => entry.guard_id === definition.surface_id);
    if (observed === undefined || !observed.applicable || !observed.executed
      || !observed.blocked || observed.error_code !== "TOMBSTONE_REINGRESS_BLOCKED"
      || observed.error_count !== 0 || observed.omission_count !== 0
      || observed.execution_count !== 1) {
      throw new JarvisError("MEMORY_REINGRESS_GUARD_OBSERVATION_INVALID");
    }
    return { ...definition, applicable: true, readable: true,
      manifest_digest: observed.observation_digest, file_count: 0,
      row_count: observed.execution_count, object_count: observed.blocked ? 1 : 0,
      fd_count: 0, match_count: 0,
      error_count: observed.error_count, omission_count: observed.omission_count,
      scan_digest: observed.observation_digest };
  }

  private localRoot(surfaceId: string): string {
    switch (surfaceId) {
      case "erasable_spool": return this.options.layout.spool_root;
      case "state_generations_caches": return this.options.layout.state_root;
      case "dist_runtime_fixtures": return this.options.layout.dist_root;
      case "managed_backups": return this.options.layout.backup_root;
      case "restore_candidates": return this.options.layout.restore_root;
      default: throw new JarvisError("MEMORY_SURFACE_CATALOG_INVALID");
    }
  }
}

const SQLITE_SURFACE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  control_requests_receipts_effects_revocations: ["control_"],
  candidates_classifications_claims: ["memory_candidate"],
  outbox_attempts_events: ["memory_outbox", "memory_reconciliation"],
  deletion_export_tombstone_delegation_proof: ["memory_deletion", "memory_export", "memory_tombstone", "memory_effect"],
  audit_retention: ["audit_", "retention_", "personal_operation_audit"],
  observations: ["personal_observation", "personal_source_checkpoint"],
  contexts_edges_snapshots: ["personal_context"],
  recommendations_actions_evidence: ["personal_recommendation"],
  daily_loop: ["daily_loop"],
  morning_briefs: ["daily_loop"],
  evening_closeout: ["daily_loop"],
  notifications: ["notification_"],
  task_timeline: ["event_ledger", "workflow_", "gjc_"],
  dashboard_api_sse: ["memory_suppression_event"],
  authority_db_main_wal_shm_journal_freelist: ["schema_migrations"],
};

function exactSurfaceCount(value: number): 70 {
  if (value !== 70) throw new JarvisError("MEMORY_SURFACE_INVENTORY_INCOMPLETE");
  return value;
}

function exactZero(value: number): 0 {
  if (value !== 0) throw new JarvisError("MEMORY_SURFACE_INVENTORY_INCOMPLETE");
  return value;
}

function assertNever(value: never): never {
  throw new JarvisError(`MEMORY_SURFACE_SCANNER_INVALID:${String(value)}`);
}
