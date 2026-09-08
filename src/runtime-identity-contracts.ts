export type RuntimeIdentityReport = {
  readonly schema_version: 1;
  readonly process: { readonly pid: number; readonly started_at: string;
    readonly node: string; readonly modules: string; readonly platform: string; readonly arch: string };
  readonly build: {
    readonly status: "matched" | "mismatch" | "missing" | "invalid" | "unreadable";
    readonly checked_at: string;
    readonly source_head: string | null;
    readonly source_dirty: boolean | null;
    readonly input_digest: string | null;
    readonly artifact_digest: string | null;
    readonly observed_artifact_digest: string | null;
    readonly artifact_files: number | null;
    readonly migration_digest: string | null;
    readonly migration_count: number | null;
    readonly toolchain_status: "matched" | "mismatch" | "unknown";
  };
  readonly database: {
    readonly status: "matched" | "mismatch" | "unverified" | "unavailable";
    readonly observed_at: string | null;
    readonly applied_migrations: number | null;
    readonly migration_digest: string | null;
    readonly missing: number | null;
    readonly unexpected: number | null;
    readonly changed: number | null;
    readonly schema_objects: number | null;
    readonly schema_digest: string | null;
  };
};

export type BuildMigration = { readonly id: string; readonly checksum: string };
