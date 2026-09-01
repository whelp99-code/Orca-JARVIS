import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { processStartToken, type RegisteredAuthorityProcess } from "./authority-database-process.js";

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
  private generation = 1;
  private quiescing = false;
  private readonly waiters = new Set<() => void>();
  private readonly processes = new Map<number, RegisteredAuthorityProcess>();
  private readonly registryPath: string;

  constructor(
    private readonly database: AuthorityDb,
    private readonly options: RuntimeOptions,
  ) {
    if (!Number.isSafeInteger(options.watchdog_ms) || options.watchdog_ms < 100
      || options.watchdog_ms > 60_000) throw new JarvisError("AUTHORITY_RUNTIME_CONFIG_INVALID");
    mkdirSync(options.registry_root, { recursive: true, mode: 0o700 });
    const current = this.registerProcess(process.pid);
    this.registryPath = join(options.registry_root, `${current.pid}.${current.start_token}.json`);
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
    return [...this.processes.values()];
  }

  close(): Promise<void> {
    if (this.activeLeases !== 0 || this.quiescing) {
      return Promise.reject(new JarvisError("AUTHORITY_DATABASE_BUSY"));
    }
    if (this.database.db.open) this.database.close();
    rmSync(this.registryPath, { force: true });
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
    if (this.registryPath === undefined) return;
    const payload = `${canonicalize({ schema_version: 1, pid: process.pid,
      start_token: processStartToken(process.pid), database: this.database.filename,
      generation: this.generation, active_leases: this.activeLeases,
      state: this.quiescing ? "quiescing" : "active" })}\n`;
    const descriptor = openSync(this.registryPath, "w", 0o600);
    try {
      writeSync(descriptor, payload);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
