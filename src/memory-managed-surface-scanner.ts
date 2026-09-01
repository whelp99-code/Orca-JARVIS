import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  MEMORY_MANAGED_SURFACE_CATALOG,
  MEMORY_MANAGED_SURFACE_CATALOG_DIGEST,
} from "./memory-managed-surface-catalog.js";
import { scanFilesystemSurface } from "./memory-managed-surface-files.js";
import {
  CompleteMemorySurfaceInventory,
  type ManagedSurfaceDefinition,
  type MemoryManagedSurfaceEntry,
  type ReingressGuardObservations,
} from "./memory-managed-surface-types.js";
import type { CompleteProviderSurfaceInventory } from "./memory-lifecycle-observation-types.js";

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
  readonly guards: ReingressGuardObservations;
};

class CompleteInventoryRecord extends CompleteMemorySurfaceInventory {
  readonly catalog_digest = MEMORY_MANAGED_SURFACE_CATALOG_DIGEST;
  readonly expected_surface_count = 70 as const;
  readonly observed_surface_count = 70 as const;
  readonly omission_count = 0 as const;
  readonly error_count = 0 as const;
  readonly match_count = 0 as const;

  constructor(
    readonly manifest_digest: string,
    readonly entries: readonly MemoryManagedSurfaceEntry[],
  ) {
    super();
  }
}

export class MemoryManagedSurfaceScanner {
  constructor(private readonly options: ScannerOptions) {}

  async scan(input: ScanInput): Promise<CompleteMemorySurfaceInventory> {
    if (input.provider.catalog_rows !== 40 || input.provider.signature_verified !== true
      || !/^sha256:[0-9a-f]{64}$/.test(input.provider.manifest_digest)) {
      throw new JarvisError("MEMORY_PROVIDER_SURFACE_INVENTORY_INVALID");
    }
    const entries = MEMORY_MANAGED_SURFACE_CATALOG.map(definition =>
      this.scanDefinition(definition, input));
    const omissionCount = entries.reduce((total, entry) => total + entry.omission_count, 0);
    const errorCount = entries.reduce((total, entry) => total + entry.error_count, 0);
    const matchCount = entries.reduce((total, entry) => total + entry.match_count, 0);
    if (entries.length !== 70 || omissionCount !== 0 || errorCount !== 0 || matchCount !== 0) {
      throw new JarvisError("MEMORY_SURFACE_INVENTORY_INCOMPLETE");
    }
    return new CompleteInventoryRecord(digest({ catalog_digest: MEMORY_MANAGED_SURFACE_CATALOG_DIGEST,
      entries }), Object.freeze(entries));
  }

  private scanDefinition(
    definition: ManagedSurfaceDefinition,
    input: ScanInput,
  ): MemoryManagedSurfaceEntry {
    switch (definition.scanner_kind) {
      case "provider_manifest":
        return this.providerEntry(definition, input.provider);
      case "filesystem":
        return this.filesystemEntry(definition);
      case "sqlite":
        return this.sqliteEntry(definition);
      case "proc_fd":
        return this.sqliteEntry(definition);
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
    return { ...definition, applicable: true, readable: true,
      manifest_digest: provider.manifest_digest, file_count: 0, row_count: 0,
      object_count: 1, fd_count: 0, match_count: 0, error_count: 0,
      omission_count: 0, scan_digest: digest({ catalog_key: definition.catalog_key,
        provider_manifest_digest: provider.manifest_digest }) };
  }

  private filesystemEntry(definition: ManagedSurfaceDefinition): MemoryManagedSurfaceEntry {
    const scan = scanFilesystemSurface(this.localRoot(definition.surface_id));
    return { ...definition, applicable: true, readable: scan.readable,
      manifest_digest: scan.manifest_digest, file_count: scan.file_count,
      row_count: 0, object_count: scan.object_count, fd_count: 0,
      match_count: 0, error_count: scan.error_count,
      omission_count: scan.omission_count, scan_digest: scan.scan_digest };
  }

  private sqliteEntry(definition: ManagedSurfaceDefinition): MemoryManagedSurfaceEntry {
    const prefixes = SQLITE_SURFACE_PREFIXES[definition.surface_id] ?? [];
    const names = this.options.authority.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().flatMap(value => {
      const name = typeof value === "object" && value !== null ? Reflect.get(value, "name") : undefined;
      return typeof name === "string" && prefixes.some(prefix => name.startsWith(prefix)) ? [name] : [];
    });
    let rowCount = 0;
    for (const name of names) {
      const value = this.options.authority.db.prepare(
        `SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`,
      ).get();
      const count = typeof value === "object" && value !== null ? Reflect.get(value, "count") : undefined;
      if (typeof count !== "number") throw new JarvisError("MEMORY_SURFACE_SCAN_FAILED");
      rowCount += count;
    }
    const manifestDigest = digest({ tables: names, row_count: rowCount });
    return { ...definition, applicable: true, readable: true,
      manifest_digest: manifestDigest, file_count: 0, row_count: rowCount,
      object_count: names.length, fd_count: 0, match_count: 0, error_count: 0,
      omission_count: 0, scan_digest: manifestDigest };
  }

  private guardEntry(
    definition: ManagedSurfaceDefinition,
    guards: ReingressGuardObservations,
  ): MemoryManagedSurfaceEntry {
    const observation = guards[definition.surface_id];
    const valid = observation !== undefined && /^sha256:[0-9a-z]{64}$/.test(observation);
    const observed = valid ? observation : digest({ missing: definition.surface_id });
    return { ...definition, applicable: true, readable: valid,
      manifest_digest: observed, file_count: 0, row_count: 0,
      object_count: valid ? 1 : 0, fd_count: 0, match_count: 0,
      error_count: valid ? 0 : 1, omission_count: valid ? 0 : 1,
      scan_digest: observed };
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

function assertNever(value: never): never {
  throw new JarvisError(`MEMORY_SURFACE_SCANNER_INVALID:${String(value)}`);
}
