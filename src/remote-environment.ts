import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";

export type EnvironmentId = "local" | "jm-server";

export type EnvironmentRecord = {
  readonly id: EnvironmentId;
  readonly hostId: string;
  readonly os: string;
  readonly arch: string;
  readonly runtimeVersion: string;
  readonly workspaceRoot: string;
  readonly orcaInstance: string;
  readonly capabilities: readonly string[];
  readonly credentialPolicy: string;
  readonly fingerprint: string;
  readonly generation: string;
  readonly available: boolean;
};

export function environmentFingerprint(input: Omit<EnvironmentRecord, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify({
    id: input.id,
    hostId: input.hostId,
    os: input.os,
    arch: input.arch,
    runtimeVersion: input.runtimeVersion,
    workspaceRoot: input.workspaceRoot,
    orcaInstance: input.orcaInstance,
  })).digest("hex");
}

export class EnvironmentRegistry {
  private readonly envs = new Map<EnvironmentId, EnvironmentRecord>();

  register(input: Omit<EnvironmentRecord, "fingerprint">): EnvironmentRecord {
    const record = { ...input, fingerprint: environmentFingerprint(input) };
    this.envs.set(record.id, record);
    return record;
  }

  get(id: EnvironmentId): EnvironmentRecord {
    const record = this.envs.get(id);
    if (!record) throw new JarvisError("ENVIRONMENT_UNREGISTERED");
    return record;
  }

  require(id: EnvironmentId, fingerprint: string, generation: string): EnvironmentRecord {
    const record = this.get(id);
    if (record.fingerprint !== fingerprint) throw new JarvisError("ENVIRONMENT_FINGERPRINT_MISMATCH");
    if (record.generation !== generation) throw new JarvisError("ENVIRONMENT_STALE_GENERATION");
    if (!record.available) throw new JarvisError("WAITING_ENVIRONMENT");
    return record;
  }
}
