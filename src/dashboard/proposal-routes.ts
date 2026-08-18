import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityProbe } from "../capabilities.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { writeDashboardJson } from "./http.js";
import { previewTeamProposal, type TeamProposalPlanner } from "./proposal-service.js";

const PREVIEW_PATH = "/api/v1/proposals/preview";
const INPUT_INVALID = "TEAM_PROPOSAL_INPUT_INVALID";

export type ProposalRouteInput = {
  readonly db: AuthorityDb;
  readonly path: string;
  readonly response: ServerResponse;
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly body: unknown;
  readonly capabilityProbe?: CapabilityProbe;
  readonly planner?: TeamProposalPlanner;
};

export async function tryHandleProposalPreview(input: ProposalRouteInput): Promise<boolean> {
  if (input.request.method !== "POST" || input.path !== PREVIEW_PATH) return false;
  const capabilityProbe = input.capabilityProbe;
  const planner = input.planner;
  if (capabilityProbe === undefined || planner === undefined) return false;
  try {
    const proposal = await previewTeamProposal({
      db: input.db,
      capabilityProbe,
      planner,
      request: input.body,
    });
    writeDashboardJson(input.response, {
      status: 200,
      requestId: input.requestId,
      body: { schema_version: DASHBOARD_SCHEMA_VERSION, proposal },
    });
    return true;
  } catch (error) {
    if (error instanceof JarvisError && error.code === INPUT_INVALID) {
      writeDashboardJson(input.response, {
        status: 400,
        requestId: input.requestId,
        body: {
          schema_version: DASHBOARD_SCHEMA_VERSION,
          error: { code: INPUT_INVALID, message: "Invalid team proposal input", request_id: input.requestId },
        },
      });
      return true;
    }
    throw error;
  }
}
