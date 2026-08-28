import { readFile } from "node:fs/promises";
import type { CliCommandContext } from "./cli-command-context.js";
import { privateKeyFile, workerCrashValue } from "./cli-command-input.js";
import { JarvisError } from "./db.js";
import { LiveSupervisor } from "./live-supervisor.js";
import { observeOrca, parseOrcaBindings } from "./orca.js";
import { OrcaTerminalResumeAdapter } from "./orca-resume.js";
import { PreGjcShadow } from "./pre-gjc-shadow.js";

export async function executeStateCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, fourth, values, db, dependencies } = context;
  if (command === "observe" && subcommand === "orca") {
    let bindings: ReturnType<typeof parseOrcaBindings> | undefined;
    if (values.bindings) {
      try {
        bindings = parseOrcaBindings(JSON.parse(await readFile(values.bindings, "utf8")));
      } catch (error) {
        if (error instanceof JarvisError) throw error;
        throw new JarvisError("ORCA_BINDINGS_INVALID");
      }
    }
    const result = await observeOrca(db, {
      worktree: values.worktree,
      bindings,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      maxPages: values.max_pages === undefined ? undefined : Number(values.max_pages),
      runner: dependencies.orcaRunner,
    });
    return { ok: true, command: "observe.orca", ...result };
  }
  const policyKeyPath = `${db.filename}.policy-key.pem`;
  if (command === "census" && subcommand === "ingest" && argument) {
    const input = JSON.parse(await readFile(argument, "utf8"));
    return { ok: true, ...db.ingest(input, await privateKeyFile(policyKeyPath)) };
  }
  if (command === "census" && subcommand === "resolve" && argument && fourth) {
    db.recordResolution(argument, JSON.parse(await readFile(fourth, "utf8")));
    return { ok: true, work_id: argument, resolution: "recorded" };
  }
  if (command === "work" && subcommand === "verify-record" && argument) {
    db.recordVerification(JSON.parse(await readFile(argument, "utf8")));
    return { ok: true, verification: "recorded" };
  }
  if (command === "status" && values.json) return { ok: true, ...db.status() };
  const shadow = new PreGjcShadow(db);
  if (command === "approval" && subcommand === "list") {
    const questions = db.db
      .prepare(
        "SELECT question_id,intent_id,snapshot_json,state,created_at,answered_at "
        + "FROM gjc_questions WHERE state='open' ORDER BY created_at,question_id",
      )
      .all();
    return {
      ok: true,
      approvals: db.listApprovals(),
      authority_requests: shadow.listAuthority(),
      gjc_questions: questions,
    };
  }
  if (command === "approval" && subcommand === "approve" && argument && fourth) {
    const continuation = db.approveWithReceipt(argument, JSON.parse(await readFile(fourth, "utf8")));
    return { ok: true, work_id: argument, ...continuation };
  }
  if (command === "approval" && subcommand === "reject" && argument && fourth) {
    db.rejectWithReceipt(argument, JSON.parse(await readFile(fourth, "utf8")));
    return { ok: true, work_id: argument, decision: "rejected" };
  }
  if (command === "resume" && subcommand === "deliver" && argument) {
    const supervisor = new LiveSupervisor(db);
    if (!supervisor.pendingLiveResumeIntents().includes(argument)) throw new JarvisError("ORCA_RESUME_DISABLED");
    shadow.deliverResume(
      argument,
      new OrcaTerminalResumeAdapter(db, true, dependencies.liveOrcaCommand, dependencies.clock),
      dependencies.clock?.() ?? new Date(),
    );
    return { ok: true, command: "resume.deliver", intent_id: argument, dispatched: true };
  }
  if (command === "worker" && subcommand === "run" && values.once) {
    return { ok: true, ...db.workerOnce(workerCrashValue(values.crash)) };
  }
  return undefined;
}
