import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const AT = "2026-08-28T10:00:00.000Z";
const EXPIRES = "2026-08-28T12:00:00.000Z";
const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_COLUMNS = [
  ["personal_observations", "canonical_digest"],
  ["personal_observations", "content_digest"],
  ["personal_source_checkpoints", "observation_digest"],
  ["personal_context_snapshots", "canonical_digest"],
  ["personal_context_observations", "observation_digest"],
  ["personal_context_evidence", "evidence_digest"],
  ["personal_recommendations", "context_digest"],
  ["personal_recommendations", "canonical_digest"],
  ["personal_recommendations", "evidence_digest"],
  ["personal_recommendations", "persistence_digest"],
  ["personal_recommendation_evidence", "evidence_digest"],
  ["personal_recommendation_actions", "target_digest"],
  ["personal_recommendation_action_events", "evidence_digest"],
  ["personal_context_audit_events", "subject_digest"],
] as const;

function isDatabaseRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function databaseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isDatabaseRecord(value)) throw new TypeError("database row required");
  return value;
}

async function seededDatabase(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  db.db.prepare("INSERT INTO personal_observations(observation_id,idempotency_key,source_id,checkpoint,canonical_digest,content_digest,canonical_envelope_json,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("obs:direct", `idem:direct:${"a".repeat(64)}`, "src:direct", "checkpoint:1", VALID_DIGEST, VALID_DIGEST, "{}", AT, AT, EXPIRES, AT);
  db.db.prepare("INSERT INTO personal_source_checkpoints(source_id,sequence,checkpoint,observation_id,observation_digest,observed_at,recorded_at) VALUES(?,?,?,?,?,?,?)").run("src:direct", 1, "checkpoint:1", "obs:direct", VALID_DIGEST, AT, AT);
  db.db.prepare("INSERT INTO personal_context_snapshots(context_id,idempotency_key,purpose,declared_query,version,canonical_digest,canonical_envelope_json,item_count,observation_count,max_items,max_excerpt_bytes,max_total_bytes,conflict_count,omission_count,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("ctx:direct", `idem:direct:${"b".repeat(64)}`, "direct", "direct", 1, VALID_DIGEST, "{}", 1, 1, 8, 1024, 8192, 0, 0, AT, AT, EXPIRES, AT);
  db.db.prepare("INSERT INTO personal_context_observations(context_id,position,observation_id,observation_digest) VALUES(?,?,?,?)").run("ctx:direct", 0, "obs:direct", VALID_DIGEST);
  db.db.prepare("INSERT INTO personal_context_evidence(context_id,position,evidence_id,source_id,evidence_kind,evidence_digest,observed_at) VALUES(?,?,?,?,?,?,?)").run("ctx:direct", 0, "evi:direct", "src:direct", "direct", VALID_DIGEST, AT);
  db.db.prepare("INSERT INTO personal_recommendations(recommendation_id,idempotency_key,context_id,context_digest,canonical_digest,evidence_digest,persistence_digest,canonical_envelope_json,approval_requirement,confidence_class,lifecycle_state,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("rec:direct", `idem:direct:${"c".repeat(64)}`, "ctx:direct", VALID_DIGEST, VALID_DIGEST, VALID_DIGEST, VALID_DIGEST, "{}", "owner", "high", "eligible", AT, AT, EXPIRES, AT);
  db.db.prepare("INSERT INTO personal_recommendation_evidence(recommendation_id,position,evidence_id,source_id,evidence_digest,observed_at) VALUES(?,?,?,?,?,?)").run("rec:direct", 0, "evi:direct", "src:direct", VALID_DIGEST, AT);
  db.db.prepare("INSERT INTO personal_recommendation_actions(recommendation_id,rank,title,operation,target_digest,initial_state) VALUES(?,?,?,?,?,?)").run("rec:direct", 1, "direct", "review", VALID_DIGEST, "pending");
  db.db.prepare("INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,?,?,?)").run("rec:direct", 1, "pending", VALID_DIGEST, AT);
  db.db.prepare("INSERT INTO personal_context_audit_events(event_type,subject_id,subject_digest,correlation_id,causation_id,occurred_at) VALUES(?,?,?,?,?,?)").run("observation_recorded", "obs:direct", VALID_DIGEST, "corr:direct", null, AT);
  return db;
}

function invalidDigest(character: "A" | "g", position: 0 | 31 | 63): string {
  const suffix = [..."a".repeat(64)];
  suffix[position] = character;
  return `sha256:${suffix.join("")}`;
}

describe("personal context remediation contracts", () => {
  it("rejects uppercase and nonhex digest characters at every suffix position for every digest column", async () => {
    const db = await seededDatabase();
    try {
      for (const [table, column] of DIGEST_COLUMNS) {
        const schemaValue = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
        const schema = databaseRecord(schemaValue)["sql"];
        if (typeof schema !== "string") throw new TypeError(`schema missing for ${table}`);
        for (const character of ["A", "g"] as const) {
          for (const position of [0, 31, 63] as const) {
            db.db.exec("DROP TABLE IF EXISTS digest_constraint_probe");
            db.db.exec(schema.replace(`CREATE TABLE ${table}`, "CREATE TABLE digest_constraint_probe"));
            db.db.exec(`INSERT INTO digest_constraint_probe SELECT * FROM ${table}`);
            expect(() => db.db.prepare(`UPDATE digest_constraint_probe SET ${column}=?`).run(invalidDigest(character, position)), `${table}.${column}:${character}:${position}`).toThrow(/constraint/i);
          }
        }
      }
    } finally { db.close(); }
  });

  it("derives every changed Task7 product module and enforces reviewability", () => {
    const base = "16d990b39dd2cf772c225ae7611fc3f3d8c4b768";
    const changed = execFileSync("git", ["diff", "--name-only", base, "--", "src"], { encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], { encoding: "utf8" });
    const modules = [...new Set(`${changed}\n${untracked}`.trim().split("\n"))]
      .filter(path => path.endsWith(".ts"))
      .sort();
    const required = ["src/authority-db.ts", "src/db.ts", "src/index.ts"];
    const omitted = required.filter(path => !modules.includes(path));
    const baselineLimits = new Map([
      ["src/control-plane.ts", { pureLines: 245, maximumLine: 721 }],
      ["src/second-brain-adapter.ts", { pureLines: 264, maximumLine: 146 }],
      ["src/second-brain-effect-v2.ts", { pureLines: 492, maximumLine: 167 }],
    ]);
    const offenders = modules.flatMap(path => {
      const lines = readFileSync(path, "utf8").split("\n");
      const pureLines = lines.filter(line => line.trim() !== "" && !line.trim().startsWith("//")).length;
      const maximumLine = Math.max(...lines.map(line => line.length));
      const limit = baselineLimits.get(path) ?? { pureLines: 250, maximumLine: 160 };
      return pureLines > limit.pureLines || maximumLine > limit.maximumLine ? [{ path, pureLines, maximumLine }] : [];
    });
    expect({ modules, omitted, offenders }).toEqual({
      modules: expect.arrayContaining(required),
      omitted: [],
      offenders: [],
    });
  });
});
