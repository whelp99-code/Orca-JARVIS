import { createHash, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { canonicalize } from "../../src/canonical.js";
import { parseCompanyFreshnessEnvelope } from "../../src/company-freshness-envelope.js";

const [action, option, path] = process.argv.slice(2);
if (action !== "freshness" || option !== "--config" || !path) throw new Error("Wrong pinned argv");
const config = z.object({ public_key: z.string(), capture: z.string(), oversized: z.boolean() })
  .parse(JSON.parse(readFileSync(path, "utf8")));
const envelope = parseCompanyFreshnessEnvelope(JSON.parse(readFileSync(0, "utf8")));
const { signature, ...unsigned } = envelope.authority;
if (!verify(null, Buffer.from(`second-brain/company-memory-authority/v1\0${canonicalize(unsigned)}`),
  config.public_key, Buffer.from(signature, "base64url"))) throw new Error("Invalid authority signature");
const expected = `sha256:${createHash("sha256").update("second-brain/company-freshness-request/v1\0")
  .update(canonicalize({ method: envelope.method, request: envelope.request, evidence: envelope.evidence })).digest("hex")}`;
if (unsigned.request_digest !== expected) throw new Error("Invalid request digest");
writeFileSync(config.capture, canonicalize({ argv: process.argv.slice(2), env: process.env, envelope }), { mode: 0o600 });
if (config.oversized) process.stdout.write("x".repeat(1_048_577));
else if (envelope.method === "read_freshness") process.stdout.write(canonicalize({
  schema_version: 2, scope: envelope.request.scope, challenge: envelope.request.challenge,
  status: "ready", checkpoint: envelope.request.observed_checkpoint,
}));
else process.stdout.write(canonicalize({ schema_version: 2, outcome: "error", code: "COMPANY_FRESHNESS_REQUIRED" }));
