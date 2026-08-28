import { parseArgs } from "node:util";
import { buildCapabilityMatrix } from "./capabilities.js";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { teamProposalFile } from "./cli-command-input.js";
import { tryExecuteReadinessCommand } from "./cli-readiness-commands.js";
import { JarvisError } from "./db.js";
import { readPortfolioHmacKey, verifyPortfolioAuthenticatedReport } from "./dashboard/portfolio-auth.js";
import { PortfolioProjection } from "./dashboard/portfolio-projection.js";
import { readPortfolioStdin } from "./dashboard/portfolio-stdin.js";
import { runtimeCapabilityProbe } from "./doctor.js";
import { planTeamProposal, type TeamProposalRequestV1 } from "./team-proposal.js";

export async function executeBootstrapCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, values, db, dependencies } = context;
  if (command === "init") {
    const decision = values.decision_public !== undefined
      && values.decision_key_id !== undefined
      && values.decision_principal !== undefined
      ? {
          publicKeyPath: values.decision_public,
          keyId: values.decision_key_id,
          principal: values.decision_principal,
        }
      : undefined;
    const verifier = values.verifier_public !== undefined
      && values.verifier_key_id !== undefined
      && values.verifier_principal !== undefined
      ? {
          publicKeyPath: values.verifier_public,
          keyId: values.verifier_key_id,
          principal: values.verifier_principal,
        }
      : undefined;
    await db.initialize({ decision, verifier });
    return {
      ok: true,
      command: "init",
      policy_key_id: "local-policy-key",
      decision_configured: Boolean(decision),
      verifier_configured: Boolean(verifier),
    };
  }
  if (command === "db" && subcommand === "migrate") {
    await db.migrate();
    return { ok: true, command: "db.migrate" };
  }
  if (command === "portfolio" && subcommand === "ingest") {
    await db.assertMigrationsReady();
    const source = values.source;
    if (source !== "local" && source !== "jm-server") throw new JarvisError("PORTFOLIO_SOURCE_INVALID");
    if (values["key-file"] === undefined) throw new JarvisError("PORTFOLIO_AUTH_REQUIRED");
    const key = await readPortfolioHmacKey(values["key-file"]);
    const input = await (dependencies.readStdin ?? readPortfolioStdin)();
    const verified = verifyPortfolioAuthenticatedReport(input, key, source);
    const payload = verified.kind === "report" ? verified.report : verified.error;
    const result = new PortfolioProjection(db).ingest(
      source,
      Buffer.from(JSON.stringify(payload), "utf8"),
      commandNow(context),
    );
    return { ok: true, command: "portfolio.ingest", ...result };
  }
  if (command !== "doctor") return undefined;
  return tryExecuteReadinessCommand({
    db,
    command,
    json: values.json === true,
    clock: dependencies.clock,
    capabilityProbe: dependencies.capabilityProbe,
    secondBrainProbe: dependencies.secondBrainProbe,
  });
}

export async function executeCoreCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, fourth, args, values, db, dependencies } = context;
  if (command === "team" && subcommand === "propose" && argument) {
    if (fourth !== undefined) throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID");
    const irrelevant = Object.keys(values).some(key => key !== "db");
    if (irrelevant) {
      try {
        parseArgs({ args: [...args], options: { db: { type: "string" } }, allowPositionals: true, strict: true });
      } catch {
        throw new JarvisError("UNKNOWN_COMMAND");
      }
    }
    const request = await teamProposalFile<TeamProposalRequestV1>(argument);
    const matrix = await buildCapabilityMatrix(
      db,
      dependencies.capabilityProbe ?? runtimeCapabilityProbe(),
      commandNow(context),
    );
    return { ok: true, command: "team.propose", proposal: planTeamProposal(request, matrix) };
  }
  if (command !== "capabilities" || values.json !== true) return undefined;
  return tryExecuteReadinessCommand({
    db,
    command,
    json: true,
    clock: dependencies.clock,
    capabilityProbe: dependencies.capabilityProbe,
    secondBrainProbe: dependencies.secondBrainProbe,
  });
}
