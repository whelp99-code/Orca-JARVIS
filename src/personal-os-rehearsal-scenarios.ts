import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JarvisError } from "./db.js";
import { AuthorityDb } from "./db.js";
import { discoverOrcaBindings } from "./orca.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";
import {
  isRehearsalScenario,
  unavailable,
  ZERO_EVENTS,
  type RehearsalEvents,
  type RehearsalScenario,
  type TypedUnavailable,
} from "./personal-os-rehearsal-contract.js";
import { currentTarget } from "./personal-os-rehearsal-release.js";
import { rehearseRollbackBranch } from "./personal-os-rehearsal-rollback.js";
import { PersonalOsError } from "./personal-os-errors.js";
import { RemoteApprovalError } from "./remote-approval-errors.js";
import { RemoteApprovalService } from "./remote-approval.js";
import { ControlPlane } from "./control-plane.js";
import { signCommandApproval } from "./control-plane-contract.js";
import { createPrivateKey } from "node:crypto";
import { ControlReceiptSigner } from "./remote-approval-signer.js";
import { gatewaySessionDigest, sha256Prefixed } from "./remote-approval-crypto.js";
import type { RemoteIngressContextV1 } from "./remote-approval-types.js";

export type ScenarioResult = {
  readonly ok: true;
  readonly rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK";
  readonly scenario: RehearsalScenario;
  readonly outcome: string;
  readonly unavailable: TypedUnavailable | null;
  readonly events: RehearsalEvents;
  readonly live_path_mutation: false;
  readonly current_after: string | null;
};

function ok(scenario: RehearsalScenario, outcome: string, extra: {
  readonly unavailable?: TypedUnavailable | null;
  readonly events?: RehearsalEvents;
  readonly current_after?: string | null;
} = {}): ScenarioResult {
  return {
    ok: true,
    rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK",
    scenario,
    outcome,
    unavailable: extra.unavailable ?? null,
    events: extra.events ?? ZERO_EVENTS,
    live_path_mutation: false,
    current_after: extra.current_after ?? null,
  };
}

export function assertScenario(value: string): RehearsalScenario {
  if (!isRehearsalScenario(value)) throw new PersonalOsError("E_USAGE");
  return value;
}

export async function jmServerOffline(): Promise<ScenarioResult> {
  const bindings = await discoverOrcaBindings({
    environment: "jm-server",
    tolerateRemoteFailure: true,
    runner: () => { throw new JarvisError("ORCA_CLI_UNAVAILABLE"); },
  });
  if (bindings.length !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  return ok("jm-server-offline", "unavailable", { unavailable: unavailable("jm_server", "ORCA_CLI_UNAVAILABLE") });
}

export function rollbackScenario(input: {
  readonly runtimeRoot: string;
  readonly dbPath: string;
  readonly head: string;
  readonly tree: string;
  readonly providerDigest: string;
  readonly newerSha: string;
}): ScenarioResult {
  const allowed = rehearseRollbackBranch({
    ...input,
    targetSha: "b".repeat(40),
    accept: true,
  });
  if (!allowed.switched || allowed.current_before !== `releases/${input.newerSha}`) {
    throw new PersonalOsError("E_REHEARSAL_GATE");
  }
  return ok("rollback", "current-switched", { current_after: allowed.current_after });
}

export function incompatibleRollback(input: {
  readonly runtimeRoot: string;
  readonly dbPath: string;
  readonly head: string;
  readonly tree: string;
  readonly providerDigest: string;
}): ScenarioResult {
  const before = currentTarget(input.runtimeRoot);
  const refused = rehearseRollbackBranch({
    ...input,
    targetSha: "c".repeat(40),
    accept: false,
  });
  if (refused.code !== "RELEASE_ROLLBACK_INCOMPATIBLE" || refused.current_after !== before || refused.unavailable === null) {
    throw new PersonalOsError("E_REHEARSAL_GATE");
  }
  return ok("schema-incompatible-rollback", "newer-binary-kept", {
    unavailable: refused.unavailable,
    current_after: refused.current_after,
  });
}

export async function expiredPasskey(input: {
  readonly dbPath: string;
  readonly anchorDir: string;
  readonly policyPath: string;
  readonly at: Date;
}): Promise<ScenarioResult> {
  const db = new AuthorityDb(input.dbPath);
  try {
    const at = input.at;
    const control = new ControlPlane(db);
    const staged = control.stage({
      schema_version: 1,
      request_id: "req-expired-passkey",
      action: "state.project",
      action_level: 1,
      target: { environment: "local" },
      args: {},
      reversible: true,
      requested_by: "principal:owner",
      requested_at: at.toISOString(),
      expires_at: new Date(at.getTime() + 3_600_000).toISOString(),
      nonce: "nonce-expired-passkey",
    }, at);
    const key = createPrivateKey(readFileSync(join(input.anchorDir, "decision.pem")));
    const policy = parsePersonalOsPolicy(JSON.parse(readFileSync(input.policyPath, "utf8")));
    const service = new RemoteApprovalService({
      db,
      control,
      policy,
      origin: "https://jarvis-rehearsal.example.invalid",
      rpId: "jarvis-rehearsal.example.invalid",
      signer: new ControlReceiptSigner(key, "decision-rehearsal", "principal:owner"),
      signerSource: "file",
      resolver: () => null,
    });
    service.ensureOwner(at);
    const ingress: RemoteIngressContextV1 = {
      schema_version: 1,
      trust_mode: "gateway",
      gateway_owner_digest: sha256Prefixed("rehearsal-owner"),
      gateway_session_digest: gatewaySessionDigest(Buffer.alloc(32, 1), "rehearsal-session"),
      public_origin: "https://jarvis-rehearsal.example.invalid",
      request_method: "POST",
      canonical_path: `/api/v1/remote-approvals/${staged.request_id}/options`,
      body_digest: sha256Prefixed("{}"),
      envelope_nonce_digest: sha256Prefixed("n"),
      issued_at: at.toISOString(),
    };
    const issued = service.issueOptions(staged.request_id, { schema_version: 1, decision: "approve" }, ingress, at);
    const later = new Date(at.getTime() + policy.remote_approval.challenge_ttl_seconds * 1000 + 1000);
    try {
      await service.verify(issued.challenge_id, Buffer.from("{}"), {
        ...ingress,
        canonical_path: `/api/v1/remote-approvals/${issued.challenge_id}/verify`,
      }, later);
      throw new PersonalOsError("E_REHEARSAL_GATE");
    } catch (error) {
      if (error instanceof PersonalOsError) throw error;
      if (!(error instanceof RemoteApprovalError) || error.reason !== "expired"
        || error.code !== "REMOTE_APPROVAL_NOT_APPLICABLE") throw error;
    }
    const challenge = db.db.prepare(
      "SELECT state, terminal_reason FROM webauthn_approval_challenges_v2 WHERE challenge_id=?",
    ).get(issued.challenge_id) as { state: string; terminal_reason: string | null } | undefined;
    const audits = db.db.prepare(
      "SELECT COUNT(*) AS n FROM personal_operation_audit_events WHERE outcome='expired' AND reason_code='expired'",
    ).get() as { n: number };
    const receipts = db.db.prepare(
      "SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?",
    ).get(staged.request_id) as { n: number };
    if (challenge?.state !== "expired" || challenge.terminal_reason !== "expired" || audits.n !== 1 || receipts.n !== 0) {
      throw new PersonalOsError("E_REHEARSAL_GATE");
    }
    return ok("expired-passkey", "fail-closed", { unavailable: unavailable("remote_approval", "expired") });
  } finally {
    db.close();
  }
}

export function crashAfterDispatch(dbPath: string, at: Date, anchorDir: string): ScenarioResult {
  return authorityFault(dbPath, at, anchorDir, "crash-after-dispatch", "claimed");
}

export function lostMemoryResponse(dbPath: string, at: Date, anchorDir: string): ScenarioResult {
  return authorityFault(dbPath, at, anchorDir, "lost-memory-response", "uncertain");
}

function authorityFault(
  dbPath: string,
  at: Date,
  anchorDir: string,
  scenario: "crash-after-dispatch" | "lost-memory-response",
  expected: "claimed" | "uncertain",
): ScenarioResult {
  const db = new AuthorityDb(dbPath);
  try {
    const control = new ControlPlane(db);
    const requestId = `req-${scenario}`;
    const staged = control.stage({
      schema_version: 1,
      request_id: requestId,
      action: "state.project",
      action_level: 1,
      target: { environment: "local" },
      args: {},
      reversible: true,
      requested_by: "principal:owner",
      requested_at: at.toISOString(),
      expires_at: new Date(at.getTime() + 600_000).toISOString(),
      nonce: `nonce-${scenario}`,
    }, at);
    const key = createPrivateKey(readFileSync(join(anchorDir, "decision.pem")));
    control.decide(signCommandApproval({
      schema_version: 1,
      receipt_id: `receipt:${requestId}`,
      request_id: requestId,
      decision: "approve",
      command_digest: staged.command_digest,
      signer_principal_id: "principal:owner",
      authenticated_session_id: "rehearsal-virtual",
      key_id: "decision-rehearsal",
      algorithm: "Ed25519",
      issued_at: at.toISOString(),
      not_before: at.toISOString(),
      expires_at: new Date(at.getTime() + 600_000).toISOString(),
      nonce: `receipt-nonce-${scenario}`,
      max_uses: 1,
      status: "issued",
    }, key), at);
    const claimed = control.claim(requestId, "rehearsal-worker", at);
    if (expected === "uncertain") {
      control.settle(requestId, claimed.fence, {
        state: "uncertain",
        effect_type: "lost-response",
        payload: { observed: false },
        failure_code: "LOST_MEMORY_RESPONSE",
      }, at);
    }
    let duplicate = 0;
    try { control.claim(requestId, "rehearsal-worker-2", at); duplicate += 1; } catch (error) {
      if (!(error instanceof JarvisError)) throw error;
    }
    const row = db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(requestId) as
      { state: string };
    if (row.state !== expected || duplicate !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
    return ok(scenario, expected, { events: { ...ZERO_EVENTS, duplicate } });
  } finally {
    db.close();
  }
}
