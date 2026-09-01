import { resolve } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";

export const PRODUCTION_DATABASE_PATHS = [
  "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
] as const;

export type ProductionDatabaseLane = {
  readonly schema_version: 1;
  readonly lane: "production-database";
  readonly state: "SKIPPED_NOT_AUTHORIZED";
  readonly open_attempts: number;
  readonly bytes_read: number;
  readonly copies_created: number;
};

function isProductionDatabase(path: string): boolean {
  const resolved = resolve(path);
  return PRODUCTION_DATABASE_PATHS.some((root) => resolved === root || resolved.startsWith(`${root}-`));
}

export class ProductionDatabaseLaneGuard {
  #open_attempts = 0;
  #bytes_read = 0;
  #copies_created = 0;

  inspect(path: string, kind: "open" | "read" | "copy"): void {
    if (!isProductionDatabase(path)) return;
    if (kind === "open") this.#open_attempts += 1;
    if (kind === "read") this.#bytes_read += 1;
    if (kind === "copy") this.#copies_created += 1;
    throw new PersonalOsError("E_PRODUCTION_DB");
  }

  receipt(): ProductionDatabaseLane {
    return {
      schema_version: 1,
      lane: "production-database",
      state: "SKIPPED_NOT_AUTHORIZED",
      open_attempts: this.#open_attempts,
      bytes_read: this.#bytes_read,
      copies_created: this.#copies_created,
    };
  }
}
