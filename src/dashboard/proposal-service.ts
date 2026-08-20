import { buildCapabilityMatrix, type CapabilityProbe } from "../capabilities.js";
import type { AuthorityDb } from "../db.js";
import { planTeamProposal, type TeamProposalResultV1 } from "../team-proposal.js";
import { parseTeamProposalRequest } from "./validation.js";

export type TeamProposalPlanner = typeof planTeamProposal;

export type ProposalPreviewInput = {
  readonly db: AuthorityDb;
  readonly capabilityProbe: CapabilityProbe;
  readonly planner: TeamProposalPlanner;
  readonly request: unknown;
};

export async function previewTeamProposal(input: ProposalPreviewInput): Promise<TeamProposalResultV1> {
  const request = parseTeamProposalRequest(input.request);
  const matrix = await buildCapabilityMatrix(input.db, input.capabilityProbe);
  return input.planner(request, matrix);
}
