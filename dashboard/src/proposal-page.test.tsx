import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredControlCommand } from "../../src/control-plane.js";
import type { CreateTaskRequest, Sha256Digest } from "../../src/dashboard/contracts.js";
import type { TeamProposalRequestV1, TeamProposalResultV1 } from "../../src/team-proposal.js";
import { ProposalPage } from "./proposal-page.js";

type ProposalMutationClient = Readonly<{
  previewProposal: (request: TeamProposalRequestV1) => Promise<TeamProposalResultV1>;
  createTask: (request: CreateTaskRequest) => Promise<StoredControlCommand>;
}>;
type GeneratedIdKind = "request_id" | "nonce" | "task_id" | "run_id";
type IdFactory = (kind: GeneratedIdKind) => string;

const NOW = new Date("2026-08-18T12:00:00.000Z");
const DEADLINE = "2026-08-18T18:00:00.000Z";
const DIGEST: Sha256Digest = `sha256:${"a".repeat(64)}`;
const IDS = {
  request_id: "request-proposal-1",
  nonce: "nonce-proposal-1",
  task_id: "task-proposal-1",
  run_id: "run-proposal-1",
} as const satisfies Record<GeneratedIdKind, string>;
const NORMALIZED_REQUEST = {
  schema_version: 1,
  objective: "Ship proposal staging",
  work_type: "development",
  completion_evidence: ["focused vitest passes", "typecheck passes"],
  constraints: ["no persistence", "receipt-bound execution"],
  requested_capabilities: ["codex"],
} as const satisfies TeamProposalRequestV1;
const READY = {
  schema_version: 1,
  status: "ready",
  proposal_digest: DIGEST,
  objective: NORMALIZED_REQUEST.objective,
  requirements: {
    work_type: NORMALIZED_REQUEST.work_type,
    constraints: NORMALIZED_REQUEST.constraints,
    completion_evidence: NORMALIZED_REQUEST.completion_evidence,
  },
  members: [
    {
      member_id: "member_leader",
      archetype: "leader",
      role: "Lead and integrate",
      scope: ["coordinate_delivery"],
      exclusions: ["grant_authority", "persist_proposal"],
      verification: ["confirm_objective_coverage"],
      preferred_capability_ids: ["codex"],
    },
    {
      member_id: "member_builder",
      archetype: "builder",
      role: "Implement changes",
      scope: ["implement_changes"],
      exclusions: ["grant_authority", "persist_proposal"],
      verification: ["run_required_checks"],
      preferred_capability_ids: ["codex"],
    },
  ],
} as const satisfies Extract<TeamProposalResultV1, { readonly status: "ready" }>;
const EXPECTED_TASK = {
  schema_version: 1,
  ...IDS,
  expected_proposal_digest: DIGEST,
  proposal_request: NORMALIZED_REQUEST,
  budget: { max_steps: 10, max_attempts_per_node: 3, deadline: DEADLINE },
} as const satisfies CreateTaskRequest;
const STAGED = {
  schema_version: 1,
  request_id: IDS.request_id,
  action: "workflow.start",
  action_level: 2,
  target: {
    environment: "local",
    run_id: IDS.run_id,
    loop_id: "agentops-default",
    correlation_id: IDS.task_id,
    task_id: IDS.task_id,
  },
  args: {
    run_id: IDS.run_id,
    loop_id: "agentops-default",
    correlation_id: IDS.task_id,
    budget: EXPECTED_TASK.budget,
    input: {
      task_id: IDS.task_id,
      objective: NORMALIZED_REQUEST.objective,
      proposal_digest: DIGEST,
      members: READY.members,
    },
  },
  reversible: true,
  requested_by: "jarvis-control-center",
  requested_at: NOW.toISOString(),
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: IDS.nonce,
  command_digest: `sha256:${"b".repeat(64)}`,
  state: "pending",
} as const satisfies StoredControlCommand;

function setup(client: ProposalMutationClient) {
  const idFactory = vi.fn<IdFactory>((kind) => IDS[kind]);
  render(
    <ProposalPage
      client={client}
      clock={() => new Date(NOW.getTime())}
      idFactory={idFactory}
    />,
  );
  return { user: userEvent.setup(), idFactory };
}

async function completeInterview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByRole("textbox", { name: "Objective" }), "  Ship proposal staging  ");
  await user.selectOptions(screen.getByRole("combobox", { name: "Work type" }), "development");
  await user.type(
    screen.getByRole("textbox", { name: "Completion evidence" }),
    " focused vitest passes \n\n typecheck passes ",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Constraints" }),
    " no persistence \n receipt-bound execution ",
  );
  await user.click(screen.getByRole("checkbox", { name: "Codex" }));
}

async function readyPage() {
  const previewProposal = vi.fn<ProposalMutationClient["previewProposal"]>().mockResolvedValue(READY);
  const createTask = vi.fn<ProposalMutationClient["createTask"]>().mockResolvedValue(STAGED);
  const current = setup({ previewProposal, createTask });
  await completeInterview(current.user);
  await current.user.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByRole("status", { name: "Proposal status" });
  return { ...current, previewProposal, createTask };
}

afterEach(cleanup);

describe("proposal interview and receipt-bound task staging", () => {
  it("previews the normalized request and exposes the ready proposal", async () => {
    // Given / When
    const current = await readyPage();

    // Then
    expect(current.previewProposal).toHaveBeenCalledOnce();
    expect(current.previewProposal).toHaveBeenCalledWith(NORMALIZED_REQUEST);
    expect(screen.getByRole("status", { name: "Proposal status" })).toHaveTextContent("Ready");
    const preview = screen.getByRole("region", { name: "Proposal preview" });
    expect(within(preview).getByText(DIGEST)).toBeInTheDocument();
    const requirements = within(preview).getByRole("region", { name: "Work requirements" });
    for (const item of [...NORMALIZED_REQUEST.constraints, ...NORMALIZED_REQUEST.completion_evidence]) {
      expect(within(requirements).getByText(item)).toBeInTheDocument();
    }
    const members = within(preview).getByRole("region", { name: "Selected members" });
    expect(within(members).getByText("member_leader")).toBeInTheDocument();
    expect(within(members).getByText("Lead and integrate")).toBeInTheDocument();
    expect(within(members).getByText("member_builder")).toBeInTheDocument();
    expect(within(members).getByText("Implement changes")).toBeInTheDocument();
    const warnings = within(preview).getByRole("region", { name: "Warnings" });
    expect(warnings).toHaveTextContent("Cannot grant authority");
    expect(warnings).toHaveTextContent("Cannot persist proposal");
    expect(screen.getByRole("status", { name: "Total budget" })).toHaveTextContent("30 attempts");
  });

  it("stages the ready proposal with deterministic identifiers and deadline", async () => {
    // Given
    const current = await readyPage();

    // When
    await current.user.click(screen.getByRole("button", { name: "Stage task" }));

    // Then
    expect(current.createTask).toHaveBeenCalledOnce();
    expect(current.createTask).toHaveBeenCalledWith(EXPECTED_TASK);
    expect(current.idFactory.mock.calls.map(([kind]) => kind)).toEqual([
      "request_id", "nonce", "task_id", "run_id",
    ]);
    const staged = await screen.findByRole("region", { name: "Staged request" });
    expect(staged).toHaveTextContent(IDS.request_id);
    expect(staged).toHaveTextContent("workflow.start");
    expect(staged).toHaveTextContent("pending");
    expect(staged).toHaveTextContent("agentops-default");
    expect(staged).toHaveTextContent(IDS.task_id);
  });

  it("renders blocked capability reasons without exposing task staging", async () => {
    // Given
    const blocked = {
      schema_version: 1,
      status: "blocked",
      reasons: [{ capability_id: "codex", stage: "operational" }],
    } as const satisfies TeamProposalResultV1;
    const previewProposal = vi.fn<ProposalMutationClient["previewProposal"]>().mockResolvedValue(blocked);
    const createTask = vi.fn<ProposalMutationClient["createTask"]>();
    const { user } = setup({ previewProposal, createTask });
    await completeInterview(user);

    // When
    await user.click(screen.getByRole("button", { name: "Preview" }));

    // Then
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Proposal blocked");
    expect(alert).toHaveTextContent("codex: operational");
    expect(screen.queryByRole("button", { name: "Stage task" })).not.toBeInTheDocument();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("renders planner questions without exposing task staging", async () => {
    // Given
    const needsInput = {
      schema_version: 1,
      status: "needs_input",
      questions: [
        { id: "work_type", text: "Choose a work type", required: true },
        { id: "completion_evidence", text: "Describe completion evidence", required: true },
      ],
    } as const satisfies TeamProposalResultV1;
    const previewProposal = vi.fn<ProposalMutationClient["previewProposal"]>().mockResolvedValue(needsInput);
    const createTask = vi.fn<ProposalMutationClient["createTask"]>();
    const { user } = setup({ previewProposal, createTask });
    await user.type(screen.getByRole("textbox", { name: "Objective" }), "Clarify the task");

    // When
    await user.click(screen.getByRole("button", { name: "Preview" }));

    // Then
    const questions = await screen.findByRole("region", { name: "More information needed" });
    expect(questions).toHaveTextContent("Choose a work type");
    expect(questions).toHaveTextContent("Describe completion evidence");
    expect(previewProposal).toHaveBeenCalledWith({ schema_version: 1, objective: "Clarify the task" });
    expect(screen.queryByRole("button", { name: "Stage task" })).not.toBeInTheDocument();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("offers retry after a transport error without losing interview input", async () => {
    // Given
    const previewProposal = vi.fn<ProposalMutationClient["previewProposal"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(READY);
    const createTask = vi.fn<ProposalMutationClient["createTask"]>();
    const { user } = setup({ previewProposal, createTask });
    await completeInterview(user);

    // When
    await user.click(screen.getByRole("button", { name: "Preview" }));

    // Then
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to preview proposal");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("  Ship proposal staging  ");
    expect(screen.getByRole("textbox", { name: "Completion evidence" })).toHaveValue(
      " focused vitest passes \n\n typecheck passes ",
    );
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("status", { name: "Proposal status" });
    expect(previewProposal).toHaveBeenCalledTimes(2);
    expect(previewProposal).toHaveBeenNthCalledWith(1, NORMALIZED_REQUEST);
    expect(previewProposal).toHaveBeenNthCalledWith(2, NORMALIZED_REQUEST);
    expect(createTask).not.toHaveBeenCalled();
  });
});
