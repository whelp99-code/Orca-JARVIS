import { createHash } from "node:crypto";

export type ProductManifest = {
  readonly schema_version: 1;
  readonly version: string;
  readonly protocol: string;
  readonly nodeMajor: number;
  readonly owner: "jarvis";
  readonly hashes: Readonly<Record<string, string>>;
  readonly backwardReadable: boolean;
};

export function hashBytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildManifest(version: string, hashes: Record<string, string>, backwardReadable = true): ProductManifest {
  return {
    schema_version: 1,
    version,
    protocol: "1.0",
    nodeMajor: 24,
    owner: "jarvis",
    hashes,
    backwardReadable,
  };
}
