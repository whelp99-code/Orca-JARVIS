import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";

type SurfaceDefinition = {
  readonly catalog_key: `surface:${number}`;
  readonly owner: "second_brain" | "exports" | "jarvis" | "reingress";
  readonly surface_id: string;
  readonly scanner_kind: "provider_manifest" | "filesystem" | "sqlite" | "proc_fd" | "guard";
  readonly required: true;
};

function isCatalog(value: unknown): value is readonly SurfaceDefinition[] {
  return Array.isArray(value) && value.every(item => typeof item === "object" && item !== null
    && Reflect.get(item, "required") === true);
}

describe("fixed owner-qualified memory surface catalog", () => {
  it("publishes exactly the frozen seventy production surfaces", () => {
    // Given: the public immutable production catalog.
    const value = Reflect.get(Jarvis, "MEMORY_MANAGED_SURFACE_CATALOG");
    expect(isCatalog(value)).toBe(true);
    if (!isCatalog(value)) return;

    // When: stable catalog identities are enumerated.
    const identities = value.map(row => `${row.owner}/${row.surface_id}`);

    // Then: all seventy rows are unique by owner and include the literal dist fixture surface.
    expect(value).toHaveLength(70);
    expect(new Set(value.map(row => row.catalog_key)).size).toBe(70);
    expect(new Set(identities).size).toBe(70);
    expect(value).toContainEqual(expect.objectContaining({ catalog_key: "surface:58",
      owner: "jarvis", surface_id: "dist_runtime_fixtures", required: true }));
    expect(identities.filter(identity => identity.endsWith("/managed_backups"))).toEqual([
      "second_brain/managed_backups", "jarvis/managed_backups",
    ]);
    expect(Reflect.get(Jarvis, "MEMORY_MANAGED_SURFACE_CATALOG_DIGEST"))
      .toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
