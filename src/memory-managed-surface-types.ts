export type MemoryManagedSurfaceOwner = "second_brain" | "exports" | "jarvis" | "reingress";
export type MemoryManagedSurfaceScannerKind = "provider_manifest" | "filesystem" | "sqlite" | "proc_fd" | "guard";

export type ManagedSurfaceDefinition = {
  readonly catalog_key: `surface:${number}`;
  readonly owner: MemoryManagedSurfaceOwner;
  readonly surface_id: string;
  readonly scanner_kind: MemoryManagedSurfaceScannerKind;
  readonly required: true;
};

export type ReingressGuardObservations = Readonly<Record<string, string>>;

export type MemoryManagedSurfaceEntry = {
  readonly catalog_key: `surface:${number}`;
  readonly owner: MemoryManagedSurfaceOwner;
  readonly surface_id: string;
  readonly scanner_kind: MemoryManagedSurfaceScannerKind;
  readonly required: true;
  readonly applicable: boolean;
  readonly readable: boolean;
  readonly manifest_digest: string;
  readonly file_count: number;
  readonly row_count: number;
  readonly object_count: number;
  readonly fd_count: number;
  readonly match_count: number;
  readonly error_count: number;
  readonly omission_count: number;
  readonly scan_digest: string;
};

export abstract class CompleteMemorySurfaceInventory {
  readonly #complete = true;
  get complete(): true { return this.#complete; }
  abstract readonly catalog_digest: string;
  abstract readonly manifest_digest: string;
  abstract readonly expected_surface_count: 70;
  abstract readonly observed_surface_count: 70;
  abstract readonly omission_count: 0;
  abstract readonly error_count: 0;
  abstract readonly match_count: 0;
  abstract readonly entries: readonly MemoryManagedSurfaceEntry[];
}
