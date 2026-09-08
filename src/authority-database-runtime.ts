import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  discoverOpenInodeHolders,
  processStartToken,
  type OpenInodeObservation,
  type RegisteredAuthorityProcess,
} from "./authority-database-process.js";
import { AuthorityProcessRegistry } from "./authority-database-registry.js";

export type ManagedReaderSurface =
  | "context" | "recommendation" | "daily" | "notification"
  | "timeline" | "dashboard" | "api" | "state";

export type AuthorityDatabaseGeneration = {
  readonly generation: number;
  readonly filename: string;
};

export type QuiescedAuthorityLease = {
  readonly authority: AuthorityDb;
  readonly source_generation: number;
};

type RuntimeOptions = {
  readonly registry_root: string;
  readonly watchdog_ms: number;
};

export class AuthorityDatabaseRuntime {
  /** Active lease count is mutable runtime ownership state. */
  private activeLeases = 0;
  private generation: number;
  private quiescing = false;
  private readonly waiters = new Set<() => void>();
  private readonly processes = new Map<number, RegisteredAuthorityProcess>();
  private readonly registry: AuthorityProcessRegistry;

  constructor(
    private readonly database: AuthorityDb,
    private readonly options: RuntimeOptions,
  ) {
    if (!Number.isSafeInteger(options.watchdog_ms) || options.watchdog_ms < 100
      || options.watchdog_ms > 60_000) throw new JarvisError("AUTHORITY_RUNTIME_CONFIG_INVALID");
    const generations = database.db.prepare("SELECT generation FROM memory_database_generations WHERE state='active'")
      .all() as Array<{ generation: number }>;
    const generation = generations[0]?.generation;
    if (generations.length !== 1 || !Number.isSafeInteger(generation) || generation! < 1)
      throw new JarvisError("AUTHORITY_DATABASE_GENERATION_INVALID");
    this.generation = generation!;
    this.registry = new AuthorityProcessRegistry(options.registry_root, database.filename);
    this.registerProcess(process.pid);
    this.persistRegistry();
  }

  async read<T>(
    surface: ManagedReaderSurface,
    operation: (db: AuthorityDb) => T | Promise<T>,
  ): Promise<T> {
    void surface;
    return this.withLease(operation);
  }

  async write<T>(operation: (db: AuthorityDb) => T | Promise<T>): Promise<T> {
    return this.withLease(operation);
  }

  async quiesce<T>(
    reason: "memory_compaction",
    operation: (lease: QuiescedAuthorityLease) => Promise<T>,
  ): Promise<T> {
    void reason;
    if (this.quiescing) throw new JarvisError("AUTHORITY_DATABASE_QUIESCING");
    this.quiescing = true;
    this.persistRegistry();
    try {
      await this.awaitDrain();
      return await operation({ authority: this.database,
        source_generation: this.generation });
    } finally {
      this.quiescing = false;
      this.persistRegistry();
    }
  }

  authorityDb(): AuthorityDb {
    return this.database;
  }

  acknowledgeGeneration(generation: number): void {
    if (generation !== this.generation + 1) {
      throw new JarvisError("AUTHORITY_DATABASE_GENERATION_INVALID");
    }
    this.generation = generation;
    this.persistRegistry();
  }

  activeGeneration(): AuthorityDatabaseGeneration {
    return { generation: this.generation, filename: this.database.filename };
  }

  registerProcess(pid: number): RegisteredAuthorityProcess {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new JarvisError("AUTHORITY_PROCESS_INVALID");
    const registered = { pid, start_token: processStartToken(pid) };
    this.processes.set(pid, registered);
    return registered;
  }

  registeredProcesses(): readonly RegisteredAuthorityProcess[] {
    const discovered = new Map(this.registry.processes().map(item => [item.pid, item]));
    for (const process of this.processes.values()) {
      if (processStartToken(process.pid) !== process.start_token) {
        throw new JarvisError("AUTHORITY_PROCESS_INVALID");
      }
      discovered.set(process.pid, process);
    }
    return [...discovered.values()].sort((left, right) => left.pid - right.pid);
  }

  observeOldInode(device: bigint, inode: bigint): OpenInodeObservation {
    const registered = this.registeredProcesses();
    return discoverOpenInodeHolders(device, inode, registered);
  }

  close(): Promise<void> {
    if (this.activeLeases !== 0 || this.quiescing) {
      return Promise.reject(new JarvisError("AUTHORITY_DATABASE_BUSY"));
    }
    if (this.database.db.open) this.database.close();
    this.registry.close();
    return Promise.resolve();
  }

  private async withLease<T>(operation: (db: AuthorityDb) => T | Promise<T>): Promise<T> {
    if (this.quiescing) throw new JarvisError("AUTHORITY_DATABASE_QUIESCING");
    this.activeLeases += 1;
    this.persistRegistry();
    try {
      return await operation(this.database);
    } finally {
      this.activeLeases -= 1;
      this.persistRegistry();
      if (this.activeLeases === 0) {
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
      }
    }
  }

  private awaitDrain(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.waiters.delete(finish);
        resolve();
      };
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.delete(finish);
        reject(new JarvisError("AUTHORITY_READER_DRAIN_TIMEOUT"));
      }, this.options.watchdog_ms);
      watchdog.unref();
      this.waiters.add(finish);
    });
  }

  private persistRegistry(): void {
    this.registry.persist({ schema_version: 1, pid: process.pid,
      start_token: processStartToken(process.pid), database: this.database.filename,
      generation: this.generation, active_leases: this.activeLeases,
      state: this.quiescing ? "quiescing" : "active" });
  }
}
