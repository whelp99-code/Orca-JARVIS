import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb, signReceipt, signVerificationEvidence } from "../src/index.js";
import type { CensusSnapshot, DecisionReceipt, VerificationEvidence } from "../src/index.js";

export const future = (minutes = 10) => new Date(Date.now() + minutes * 60_000).toISOString();
export function tempDb(): string { return join(mkdtempSync(join(tmpdir(), "jarvis-test-")), "authority.sqlite"); }
let migratedTemplate = "";
export async function migratedDbFile(): Promise<string> {
  if (!migratedTemplate) {
    const path = tempDb();
    const db = new AuthorityDb(path);
    await db.migrate();
    db.db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    migratedTemplate = path;
  }
  const dest = tempDb();
  copyFileSync(migratedTemplate, dest);
  return dest;
}
const externalKeys = new WeakMap<AuthorityDb, { decision: KeyObject; verifier: KeyObject }>();
const externalByFilename = new Map<string, { decision: KeyObject; verifier: KeyObject }>();
export function externalAnchors() { const decision = generateKeyPairSync("ed25519"); const verifier = generateKeyPairSync("ed25519"); const directory = mkdtempSync(join(tmpdir(), "jarvis-external-keys-")); const decisionPublic = join(directory, "decision.pub.pem"); const verifierPublic = join(directory, "verifier.pub.pem"); writeFileSync(decisionPublic, decision.publicKey.export({ type: "spki", format: "pem" })); writeFileSync(verifierPublic, verifier.publicKey.export({ type: "spki", format: "pem" })); return { decision: decision.privateKey, verifier: verifier.privateKey, decisionPublic, verifierPublic }; }
export function bindExternal(db: AuthorityDb, anchors: { decision: KeyObject; verifier: KeyObject }): void { externalKeys.set(db, anchors); externalByFilename.set(db.filename, anchors); }
export async function initialized(): Promise<AuthorityDb> { const db = new AuthorityDb(await migratedDbFile()); const anchors = externalAnchors(); await db.initialize({ decision: { keyId: "decision-test", principal: "test-operator", publicKeyPath: anchors.decisionPublic }, verifier: { keyId: "verifier-test", principal: "independent-verifier", publicKeyPath: anchors.verifierPublic } }); bindExternal(db, anchors); return db; }
export function localKey(db: AuthorityDb): KeyObject { const key = (externalKeys.get(db) ?? externalByFilename.get(db.filename))?.decision; if (!key) throw new Error("external decision key unavailable"); return key; }
export function policyKey(db: AuthorityDb): KeyObject { return createPrivateKey(readFileSync(`${db.filename}.policy-key.pem`, "utf8")); }
export function verifierKey(db: AuthorityDb): KeyObject { const key = (externalKeys.get(db) ?? externalByFilename.get(db.filename))?.verifier; if (!key) throw new Error("external verifier key unavailable"); return key; }
export function untrustedKey(): KeyObject { return generateKeyPairSync("ed25519").privateKey; }
export function snapshot(targetKind: "codex" | "claude" = "codex", overrides: Partial<CensusSnapshot["work"][number]> = {}): CensusSnapshot {
  return { version: 1, project_id: `${targetKind}-project`, target_kind: targetKind, baseline: "abc123", policy_hash: "policy-v1", observed_at: new Date().toISOString(), work: [{ id: `${targetKind}-work`, proposal_hash: `sha256:${targetKind.padEnd(64, "0")}`, status: "open", kind: "code", authorization: "both", baseline: "abc123", policy_hash: "policy-v1", action: "continue_shadow", scope: { paths: ["src/**"] }, forbidden_actions: ["network", "git_push"], budget: { max_tokens: 100 }, expected_effect: "shadow_mock_only", reversible: true, attempt_id: "attempt-1", deadline: future(), lease: { id: "lease-1", epoch: 1, fencing_token: 7 }, repo_id: `${targetKind}-repo`, worktree_id: "main", terminal_kind: targetKind, terminal_session_id: `${targetKind}-terminal`, census_run_id: "run-1", verify_allowlist: [{ argv: ["jarvis", "verify", "--safe-noop"], cwd: "/shadow", expected_exit: 0 }], ...overrides }] };
}
export function decisionReceiptFor(db: AuthorityDb, workId: string, decision: "approve" | "reject" = "approve"): DecisionReceipt { const work = db.db.prepare("SELECT w.*,s.digest AS snapshot_digest,p.id AS project_id FROM work_items w JOIN census_snapshots s ON s.id=w.snapshot_id JOIN projects p ON p.id=s.project_id WHERE w.id=?").get(workId) as Record<string, unknown>; const at = new Date().toISOString(); return signReceipt({ schema_version: 1, receipt_id: `receipt-${decision}-${workId}`, decision, proposal_hash: String(work.proposal_hash), signer_principal_id: "test-operator", authenticated_session_id: "external-session", key_id: "decision-test", algorithm: "Ed25519", project_id: String(work.project_id), repo_id: String(work.repo_id), worktree_id: String(work.worktree_id), terminal_kind: String(work.terminal_kind), terminal_session_id: String(work.terminal_session_id), census_run_id: String(work.census_run_id), census_item_id: String(work.census_item_id), snapshot_digest: String(work.snapshot_digest), attempt_id: String(work.attempt_id), action_digest: String(work.action_digest), scope_digest: String(work.scope_digest), forbidden_actions: JSON.parse(String(work.forbidden_json)) as string[], forbidden_digest: String(work.forbidden_digest), policy_hash: String(work.policy_hash), budget_digest: String(work.budget_digest), expected_effect: String(work.expected_effect), reversible: Boolean(work.reversible), issued_at: at, not_before: at, expires_at: future(), nonce: `external-${decision}-${workId}`, max_uses: 1, status: "issued" }, localKey(db)); }
export function evidenceFor(db: AuthorityDb, workId: string): VerificationEvidence { const work = db.db.prepare("SELECT w.*,s.digest AS snapshot_digest FROM work_items w JOIN census_snapshots s ON s.id=w.snapshot_id WHERE w.id=?").get(workId) as Record<string, unknown>; const command = (JSON.parse(String((db.db.prepare("SELECT payload_json FROM census_snapshots WHERE id=?").get(work.snapshot_id) as { payload_json: string }).payload_json)) as CensusSnapshot).work.find(item => item.id === workId)!.verify_allowlist[0]!; return signVerificationEvidence({ schema_version: 1, evidence_id: `verify-${workId}`, work_id: workId, attempt_id: String(work.attempt_id), snapshot_digest: String(work.snapshot_digest), action_digest: String(work.action_digest), policy_hash: String(work.policy_hash), scope_digest: String(work.scope_digest), lease_epoch: Number(work.lease_epoch), fencing_token: Number(work.fencing_token), argv: command.argv, cwd: command.cwd, expected_exit: 0, actual_exit: 0, issued_at: new Date().toISOString(), signer_key_id: "verifier-test" }, verifierKey(db)); }
export function resolutionFor(source: CensusSnapshot): CensusSnapshot { return { ...source, observed_at: new Date(Date.parse(source.observed_at) + 60_000).toISOString(), work: [] }; }
