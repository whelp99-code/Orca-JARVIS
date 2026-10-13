import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { JarvisError } from "./jarvis-error.js";
import type { PersonalSourceSnapshot } from "./personal-connector-types.js";
import { freezePersonalSnapshot, personalConnectorDigest } from "./personal-connector-values.js";

const configSchema = z.object({
  snapshot_file: z.string().refine(isAbsolute),
  producer_uid: z.int().nonnegative(),
}).strict().readonly();
const summarySchema = z.object({
  schema_version: z.literal(1),
  observed_at: z.iso.datetime(),
  incomplete_count: z.int().nonnegative(),
  oldest_incomplete_age_ms: z.int().nonnegative().nullable(),
}).strict().refine(value => (value.incomplete_count === 0) === (value.oldest_incomplete_age_ms === null));
export type MessengerConnectorConfig = z.infer<typeof configSchema>;

export function parseMessengerConnectorConfig(value: unknown): MessengerConnectorConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MESSENGER_READ_CONFIG_INVALID");
  return parsed.data;
}

/** Aggregate snapshot only: the JARVIS process never opens the inbox or Slack credentials. */
export class MessengerPersonalConnectorSource {
  readonly connectorId = "messenger" as const;
  private readonly config: MessengerConnectorConfig;

  constructor(config: MessengerConnectorConfig) { this.config = parseMessengerConnectorConfig(config); }

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    try {
      const path = this.config.snapshot_file;
      const parent = dirname(path);
      if (realpathSync(parent) !== parent) throw new JarvisError("MESSENGER_READ_REFUSED");
      const directory = statSync(parent);
      if (!directory.isDirectory() || directory.uid !== this.config.producer_uid || (directory.mode & 0o022) !== 0) {
        throw new JarvisError("MESSENGER_READ_REFUSED");
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: string;
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.uid !== this.config.producer_uid || (info.mode & 0o7777) !== 0o640
          || info.size === 0 || info.size > 4_096) throw new JarvisError("MESSENGER_READ_REFUSED");
        const buffer = Buffer.alloc(4_097);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        if (size !== info.size) throw new JarvisError("MESSENGER_READ_REFUSED");
        raw = buffer.subarray(0, size).toString("utf8");
      } finally { closeSync(fd); }
      const parsed = summarySchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new JarvisError("MESSENGER_READ_REFUSED");
      const summary = parsed.data;
      const observed = Date.parse(summary.observed_at);
      const elapsed = now.getTime() - observed;
      if (!Number.isSafeInteger(observed) || !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 60_000
        || (summary.oldest_incomplete_age_ms !== null && summary.oldest_incomplete_age_ms > observed)) {
        throw new JarvisError("MESSENGER_READ_REFUSED");
      }
      const age = summary.oldest_incomplete_age_ms === null ? null : summary.oldest_incomplete_age_ms + elapsed;
      if (age !== null && !Number.isSafeInteger(age)) throw new JarvisError("MESSENGER_READ_REFUSED");
      const empty = summary.incomplete_count === 0;
      const cursor = personalConnectorDigest(summary);
      return freezePersonalSnapshot({
        connector_id: this.connectorId, source_version: "messenger-inbox-summary-v1", incarnation: null,
        sequence: observed, cursor, observed_at: summary.observed_at,
        fresh_until: new Date(observed + 60_000).toISOString(), status: empty ? "no_data" : "current",
        evidence_refs: empty ? [] : [cursor],
        values: empty ? {} : {
          incomplete_count: summary.incomplete_count, oldest_incomplete_age_ms: age, observed_at: summary.observed_at,
        },
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new JarvisError("MESSENGER_READ_REFUSED");
    }
  }
}
