import { request } from "node:http";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { JarvisError } from "./jarvis-error.js";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";
import type { PersonalSourceSnapshot } from "./personal-connector-types.js";
import { freezePersonalSnapshot, personalConnectorDigest } from "./personal-connector-values.js";

const configSchema = z.object({
  base_url: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/"
      && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  }),
  session_file: z.string().refine(isAbsolute),
}).strict().readonly();
const summarySchema = z.object({
  ready: z.boolean(),
  counts: z.object({ messages: z.int().nonnegative(), threads: z.int().nonnegative() }),
});
export type MailConnectorConfig = z.infer<typeof configSchema>;

export function parseMailConnectorConfig(value: unknown): MailConnectorConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("MAIL_READ_CONFIG_INVALID");
  return parsed.data;
}

/** Uses an existing session only. Never logs in, refreshes Graph, or changes mail state. */
export class MailPersonalConnectorSource {
  readonly connectorId = "mail" as const;
  private readonly config: MailConnectorConfig;

  constructor(config: MailConnectorConfig) { this.config = parseMailConnectorConfig(config); }

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    const token = readCandidateCredential(this.config.session_file).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new JarvisError("MAIL_READ_CREDENTIAL_INVALID");
    const body = await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new JarvisError("MAIL_READ_REFUSED"));
      const outgoing = request(new URL("/api/storage/status", this.config.base_url), {
        method: "GET", headers: { cookie: `mi_session=${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      }, incoming => {
        if (incoming.statusCode !== 200) { incoming.resume(); fail(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) { incoming.destroy(); outgoing.destroy(); fail(); }
          else chunks.push(chunk);
        });
        incoming.on("error", fail);
        incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      outgoing.on("error", fail);
      outgoing.end();
    });
    let value: unknown;
    try { value = JSON.parse(body); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new JarvisError("MAIL_READ_RESPONSE_INVALID");
    }
    const parsed = summarySchema.safeParse(value);
    if (!parsed.success) throw new JarvisError("MAIL_READ_RESPONSE_INVALID");
    const observedAt = now.toISOString();
    const counts = parsed.data.counts;
    const empty = counts.messages === 0 && counts.threads === 0;
    const status = !parsed.data.ready ? "unavailable" : empty ? "no_data" : "current";
    // This is a local observation, not producer sync freshness, revision or pagination.
    const cursor = personalConnectorDigest({ observed_at: observedAt, status, counts });
    return freezePersonalSnapshot({
      connector_id: this.connectorId, source_version: "mail-storage-summary-v1", incarnation: null,
      sequence: now.getTime(), cursor, observed_at: observedAt,
      fresh_until: status === "no_data" ? observedAt : null, status,
      evidence_refs: status === "current" ? [cursor] : [],
      values: status === "current" ? {
        message_count: counts.messages, thread_count: counts.threads, observed_at: observedAt,
      } : {},
    });
  }
}
