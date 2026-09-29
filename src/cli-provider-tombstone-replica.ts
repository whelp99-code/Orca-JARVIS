import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { JarvisError } from "./db.js";
import type { CliCommandContext } from "./cli-command-context.js";
import { learnProviderTombstoneReplica } from "./provider-tombstone-replica-learn.js";

export async function learnProviderTombstonesFromFile(context: CliCommandContext): Promise<Record<string, unknown>> {
  const path = context.argument;
  const keyFile = context.values["key-file"];
  if (path === undefined || context.fourth !== undefined || keyFile === undefined) {
    throw new JarvisError("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  }
  const pem = readFileSync(keyFile, "utf8");
  const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const signingKeyId = typeof document === "object" && document !== null && !Array.isArray(document)
    ? Reflect.get(document, "signing_key_id") : undefined;
  if (typeof signingKeyId !== "string" || signingKeyId.length === 0) throw new JarvisError("PROVIDER_TOMBSTONE_REPLICA_INVALID");
  const learnedAt = context.dependencies.clock?.().toISOString() ?? new Date().toISOString();
  const stamp = learnedAt.includes(".") ? learnedAt.replace(/(\.\d{3})\d*Z$/, "$1Z") : `${learnedAt.slice(0, 19)}.000Z`;
  const provider = process.env.JARVIS_MEMORY_PROVIDER_INSTANCE_ID;
  const high = learnProviderTombstoneReplica(context.db, document, new Map([[signingKeyId, createPublicKey(pem)]]),
    stamp, provider === undefined || provider.length === 0 ? undefined : provider);
  return { ok: true, command: "memory.learn-provider-tombstones", sequence: high.sequence, set_root: high.set_root };
}
