import { realpathSync } from "node:fs";
import { ingestClaudeHookEvent, ingestCodexAppServerEvent } from "./adapters.js";
import type { CliCommandContext } from "./cli-command-context.js";
import {
  integer,
  jsonFile,
  keyPurposeValue,
  objectValue,
  providerValue,
  typedObject,
} from "./cli-command-input.js";
import { JarvisError } from "./db.js";
import {
  PreGjcShadow,
  type AuthorityReceipt,
  type AuthorityRequest,
  type ShadowKey,
} from "./pre-gjc-shadow.js";

export async function executePreGjcCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, fourth, fifth, sixth, db } = context;
  const shadow = new PreGjcShadow(db);
  if (command === "approval" && subcommand === "ingest" && argument) {
    const receipt = typedObject(await jsonFile<AuthorityReceipt>(argument));
    return {
      ok: true,
      command: "approval.ingest",
      intent_id: shadow.recordAuthorityReceipt(receipt) ?? null,
      dispatched: false,
    };
  }
  const area = command === "pre-gjc" ? subcommand : command;
  const action = command === "pre-gjc" ? argument : subcommand;
  const target = command === "pre-gjc" ? fourth : argument;
  const extra = command === "pre-gjc" ? fifth : fourth;
  const final = command === "pre-gjc" ? sixth : fifth;
  if (area === "keys" && action === "register" && target) {
    shadow.registerKey(typedObject(await jsonFile<ShadowKey>(target)));
    return { ok: true, command: "pre-gjc.keys.register" };
  }
  if (area === "keys" && action === "revoke" && target) {
    const input = objectValue(await jsonFile(target));
    shadow.revokeKey(
      String(input.key_id ?? ""),
      providerValue(input.provider),
      keyPurposeValue(input.purpose),
      String(input.reason ?? ""),
    );
    return { ok: true, command: "pre-gjc.keys.revoke" };
  }
  if (area === "projects" && action === "configure" && target) {
    const input = objectValue(await jsonFile(target));
    shadow.configureProject(
      String(input.project_id ?? ""),
      providerValue(input.provider),
      Number(input.token_budget),
      Number(input.cache_budget),
      input.max_attempts === undefined ? undefined : Number(input.max_attempts),
    );
    return { ok: true, command: "pre-gjc.projects.configure" };
  }
  if (area === "projects" && (action === "pause" || action === "resume") && target) {
    shadow.setPaused(target, action === "pause");
    return { ok: true, command: `pre-gjc.projects.${action}`, project_id: target };
  }
  if (area === "projects" && action === "status") {
    return { ok: true, command: "pre-gjc.projects.status", status: shadow.status() };
  }
  if (area === "candidates" && action === "ingest" && target && extra) {
    const envelope = objectValue(await jsonFile(extra));
    const provider = providerValue(objectValue(envelope.progress_signal).provider);
    const signal = provider === "codex"
      ? ingestCodexAppServerEvent(envelope)
      : ingestClaudeHookEvent(envelope);
    let worktree = target;
    try {
      worktree = realpathSync(target);
    } catch {
      worktree = target;
    }
    return { ok: true, command: "pre-gjc.candidates.ingest", ...shadow.enqueueCandidate(worktree, signal) };
  }
  if (area === "candidates" && action === "process" && target && extra) {
    const claim = shadow.claimNext(target);
    if (!claim) return { ok: true, command: "pre-gjc.candidates.process", claim: null };
    return { ok: true, command: "pre-gjc.candidates.process", claim, ...shadow.stageCandidate(claim, extra) };
  }
  if (area === "candidates" && action === "recover") {
    return { ok: true, command: "pre-gjc.candidates.recover", recovered: shadow.recoverCandidates() };
  }
  if (area === "authority" && action === "list") {
    return { ok: true, command: "pre-gjc.authority.list", requests: shadow.listAuthority() };
  }
  if (area === "authority" && action === "request" && target) {
    const request = typedObject(await jsonFile<AuthorityRequest>(target));
    return { ok: true, command: "pre-gjc.authority.request", request_id: shadow.requestAuthority(request) };
  }
  if (area === "authority" && action === "consume" && target) {
    const receipt = typedObject(await jsonFile<AuthorityReceipt>(target));
    return {
      ok: true,
      command: "pre-gjc.authority.consume",
      intent_id: shadow.recordAuthorityReceipt(receipt),
      dispatched: false,
    };
  }
  if (area === "reports" && action === "pending") {
    return { ok: true, command: "pre-gjc.reports.pending", reports: shadow.pendingReports() };
  }
  if (area === "reports" && action === "claim" && target) {
    return { ok: true, command: "pre-gjc.reports.claim", report: shadow.claimReport(target) ?? null };
  }
  if (area === "reports" && action === "ack" && target && extra && final) {
    shadow.acknowledgeReport({ report_id: target, fence: integer(extra) }, await jsonFile(final));
    return { ok: true, command: "pre-gjc.reports.ack", report_id: target };
  }
  if (area === "evidence" && action === "record" && target) {
    const input = objectValue(await jsonFile(target));
    const kind = evidenceKind(input.kind);
    const id = shadow.recordCompletionEvidence(String(input.project_id ?? ""), kind, input.payload, new Date());
    return { ok: true, command: "pre-gjc.evidence.record", evidence_id: id };
  }
  if (area === "census" && action === "record" && target) {
    const input = objectValue(await jsonFile(target));
    const id = shadow.recordCensus(String(input.project_id ?? ""), input.payload, new Date());
    return { ok: true, command: "pre-gjc.census.record", evidence_id: id };
  }
  if (area === "proposal" && action === "list") {
    return { ok: true, command: "pre-gjc.proposal.list", proposals: shadow.listProposals() };
  }
  if (command === "pre-gjc" && subcommand === "status") {
    return { ok: true, command: "pre-gjc.status", status: shadow.status() };
  }
  return undefined;
}

function evidenceKind(value: unknown): "focused" | "integration" | "crash_replay" | "cli" | "full" | "node24" {
  if (value === "focused" || value === "integration" || value === "crash_replay"
    || value === "cli" || value === "full" || value === "node24") return value;
  throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
}
