import { createPublicKey } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { companyPageSchema, parseCompanyHandoff, parseCompanyCommand } from "./company-candidate-contract.js";
import { ControlPlane } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import type { CompanyClient, CompanyContext } from "./company-candidate-transport.js";

/** SB enrollment binds this fence, not the role-specific caller agent/session. */
export function companyEnrollmentContext(context: CompanyContext) {
  return {
    provider_instance_id: context.provider_instance_id, workspace_id: context.workspace_id, owner: context.owner,
    projects: context.projects, policy_revision: context.policy_revision, deletion_sequence: context.deletion_sequence,
    deletion_set_root: context.deletion_set_root, processor_principal_id: context.processor_principal_id,
  };
}

export function assertCompanyContext(command: ReturnType<typeof parseCompanyCommand>, context: CompanyContext): void {
  const expected = {
    provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id,
    owner: command.args.owner,
    projects: context.projects, policy_revision: command.args.policy_revision,
    deletion_sequence: command.args.deletion_sequence, deletion_set_root: command.args.deletion_set_root,
    processor_principal_id: command.args.processor_principal_id,
  };
  if (canonicalize(expected) !== canonicalize(companyEnrollmentContext(context))
    || (command.args.projects.length === 0 && context.projects.length > 0)
    || command.args.projects.some(project => !context.projects.includes(project))) {
    throw new JarvisError("COMPANY_CONTEXT_MISMATCH");
  }
}

/** Ordinary handoff/processor key material can never double as representative authority. */
export function assertCompanyKeySeparation(db: AuthorityDb, client: CompanyClient): void {
  const raw = createPublicKey(client.publicKeyPem).export({ format: "der", type: "spki" });
  const keys = db.db.prepare(
    `SELECT k.key_id,k.public_key_pem FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE p.purpose='decision'`,
  ).all() as { key_id: string; public_key_pem: string }[];
  if (keys.some(key => key.key_id === client.keyId
    || createPublicKey(key.public_key_pem).export({ format: "der", type: "spki" }).equals(raw))) {
    throw new JarvisError("COMPANY_CREDENTIAL_NOT_SEPARATE");
  }
}

export function importCompanyPage(db: AuthorityDb, value: unknown, context: CompanyContext, now = new Date()) {
  const parsed = companyPageSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(now.getTime())) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  const page = parsed.data;
  const items = page.handoffs.map(parseCompanyHandoff);
  const control = new ControlPlane(db);
  return db.db.transaction(() => {
    let imported = 0; let duplicate = 0; let superseded = 0;
    for (const item of items) {
      assertCompanyContext(item.command, context);
      const prior = db.db.prepare(
        "SELECT command_digest,context_json,current FROM company_candidate_handoffs WHERE request_id=?",
      ).get(item.command.request_id) as { command_digest: string; context_json: string; current: number } | undefined;
      if (prior) {
        if (prior.command_digest !== item.command_digest
          || canonicalize(companyEnrollmentContext(JSON.parse(prior.context_json))) !== canonicalize(companyEnrollmentContext(context))
          || prior.current !== 1) throw new JarvisError("COMPANY_HANDOFF_REPLAY_CONFLICT");
        duplicate++; continue;
      }
      if (Date.parse(item.command.requested_at) > now.getTime()
        || Date.parse(item.command.expires_at) <= now.getTime()) throw new JarvisError("COMPANY_HANDOFF_EXPIRED");
      const old = db.db.prepare(
        `SELECT h.request_id,h.generation,h.status,r.state,r.expires_at FROM company_candidate_handoffs h
         JOIN control_command_requests r USING(request_id) WHERE h.idempotency_key=? AND h.current=1`,
      ).get(item.idempotency_key) as {
        request_id: string; generation: number; status: string; state: string; expires_at: string;
      } | undefined;
      if (old) {
        if (item.generation <= old.generation || Date.parse(old.expires_at) > now.getTime()
          || old.state !== "pending" || old.status !== "imported") throw new JarvisError("COMPANY_HANDOFF_GENERATION_CONFLICT");
        control.cancel({ request_id: old.request_id, reason: "company handoff expired generation superseded",
          actor: "company-handoff-importer", revoked_at: now.toISOString() }, now);
        db.db.prepare(
          "UPDATE company_candidate_handoffs SET current=0,status='superseded',updated_at=? WHERE request_id=?",
        ).run(now.toISOString(), old.request_id);
        superseded++;
      }
      control.stage(item.command, now);
      db.db.prepare(
        `INSERT INTO company_candidate_handoffs(request_id,idempotency_key,generation,command_digest,
         context_json,imported_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
      ).run(item.command.request_id, item.idempotency_key, item.generation, item.command_digest,
        canonicalize(context), now.toISOString(), now.toISOString());
      imported++;
    }
    return { imported, duplicate, superseded, count: page.count, limit: page.limit, offset: page.offset };
  }).immediate();
}

export async function pullCompanyCandidates(db: AuthorityDb, client: CompanyClient, limit = 100, offset = 0,
  clock: () => Date = () => new Date()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new JarvisError("COMPANY_HANDOFF_INVALID");
  }
  assertCompanyKeySeparation(db, client);
  const value = await client.call("handoff", { limit, offset }, clock());
  const page = companyPageSchema.safeParse(value);
  if (!page.success || page.data.limit !== limit || page.data.offset !== offset) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  return importCompanyPage(db, page.data, client.context, clock());
}
