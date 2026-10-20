import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const path = process.argv[2];
const bytes = Buffer.from("TEST_ONLY actual verified downstream file effect\n");
if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
const actual = readFileSync(path);
if (!actual.equals(bytes)) throw new Error("Actual downstream readback mismatch");
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
process.stdout.write(JSON.stringify({ schema_version: 2, state: "completed",
  request_id: input.command.request_id, command_digest: digest(canonical(input.command)),
  candidate_id: input.command.target.candidate_id, content_digest: input.command.target.content_digest,
  acceptance_receipt_digest: input.acceptance.receipt_digest, effect_digest: digest(actual) }));
