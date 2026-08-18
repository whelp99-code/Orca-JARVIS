import { useState, type SyntheticEvent } from "react";
import type { CapabilityFact } from "../../src/capabilities.js";
import type { CreateTaskRequest, Sha256Digest } from "../../src/dashboard/contracts.js";
import type {
  TeamProposalRequestV1,
  TeamProposalResultV1,
  TeamWorkType,
} from "../../src/team-proposal.js";
import { DashboardApiError } from "./api.js";
import {
  createProposalMutationClient,
  type ProposalMutationClient,
} from "./api-mutations.js";
import {
  ProposalPreviewPane,
  type PreviewState,
  type StageState,
} from "./proposal-result.js";

export type GeneratedIdKind = "request_id" | "nonce" | "task_id" | "run_id";
export type IdFactory = (kind: GeneratedIdKind) => string;

export type ProposalPageProps = Readonly<{
  client?: ProposalMutationClient;
  clock?: () => Date;
  idFactory?: IdFactory;
}>;

type CapabilityOption = Readonly<{
  id: CapabilityFact["id"];
  label: string;
}>;

const CAPABILITIES = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "orca_read", label: "Orca read" },
  { id: "gjc", label: "GJC" },
  { id: "live_resume", label: "Live resume" },
] as const satisfies readonly CapabilityOption[];
const WORK_TYPES = ["research", "development", "analysis", "content", "product"] as const;
const MAX_STEPS = 10;
const MAX_ATTEMPTS_PER_NODE = 3;
const DEADLINE_HOURS = 6;
const DEFAULT_CLIENT = createProposalMutationClient();
const SYSTEM_CLOCK = (): Date => new Date();
const SYSTEM_ID_FACTORY: IdFactory = (kind) => `${kind}-${globalThis.crypto.randomUUID()}`;

export function ProposalPage({
  client = DEFAULT_CLIENT,
  clock = SYSTEM_CLOCK,
  idFactory = SYSTEM_ID_FACTORY,
}: ProposalPageProps = {}) {
  const [objective, setObjective] = useState("");
  const [workType, setWorkType] = useState<TeamWorkType | "">("");
  const [completionEvidence, setCompletionEvidence] = useState("");
  const [constraints, setConstraints] = useState("");
  const [capabilities, setCapabilities] = useState<readonly CapabilityFact["id"][]>([]);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [stage, setStage] = useState<StageState>({ kind: "idle" });

  function clearResult(): void {
    setPreview({ kind: "idle" });
    setStage({ kind: "idle" });
  }

  async function loadPreview(request: TeamProposalRequestV1): Promise<void> {
    setPreview({ kind: "loading", request });
    setStage({ kind: "idle" });
    try {
      setPreview({ kind: "complete", request, result: await client.previewProposal(request) });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setPreview({ kind: "error", request });
    }
  }

  async function stageTask(
    request: TeamProposalRequestV1,
    result: Extract<TeamProposalResultV1, { readonly status: "ready" }>,
  ): Promise<void> {
    const digest = parseDigest(result.proposal_digest);
    if (digest === undefined) {
      setStage({ kind: "error" });
      return;
    }
    const request_id = idFactory("request_id");
    const nonce = idFactory("nonce");
    const task_id = idFactory("task_id");
    const run_id = idFactory("run_id");
    const deadline = new Date(clock().getTime() + DEADLINE_HOURS * 60 * 60 * 1_000).toISOString();
    const task = {
      schema_version: 1,
      request_id,
      nonce,
      task_id,
      run_id,
      expected_proposal_digest: digest,
      proposal_request: request,
      budget: { max_steps: MAX_STEPS, max_attempts_per_node: MAX_ATTEMPTS_PER_NODE, deadline },
    } as const satisfies CreateTaskRequest;
    setStage({ kind: "loading" });
    try {
      setStage({ kind: "success", command: await client.createTask(task), task });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setStage({ kind: "error" });
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    void loadPreview(buildRequest({
      objective,
      workType,
      completionEvidence,
      constraints,
      capabilities,
    }));
  }

  return (
    <main className="page-frame dashboard-main proposal-page">
      <header className="proposal-heading">
        <h1>New proposal</h1>
        <p>Preview a bounded team, then stage its receipt-bound task request.</p>
      </header>
      <div className="proposal-layout">
        <form className="panel proposal-form" onSubmit={submit}>
          <header className="panel-header"><h2>Proposal interview</h2></header>
          <div className="proposal-form-body">
            <label className="form-field">
              <span>Objective</span>
              <textarea
                required
                value={objective}
                onChange={(event) => { setObjective(event.target.value); clearResult(); }}
              />
            </label>
            <label className="form-field">
              <span>Work type</span>
              <select
                value={workType}
                onChange={(event) => { setWorkType(parseWorkType(event.target.value)); clearResult(); }}
              >
                <option value="">Not selected</option>
                {WORK_TYPES.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Completion evidence</span>
              <textarea
                value={completionEvidence}
                onChange={(event) => { setCompletionEvidence(event.target.value); clearResult(); }}
              />
            </label>
            <label className="form-field">
              <span>Constraints</span>
              <textarea
                value={constraints}
                onChange={(event) => { setConstraints(event.target.value); clearResult(); }}
              />
            </label>
            <fieldset className="capability-fieldset">
              <legend>Requested capabilities</legend>
              <div className="capability-options">
                {CAPABILITIES.map((option) => (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(option.id)}
                      onChange={(event) => {
                        setCapabilities((current) => event.target.checked
                          ? [...current, option.id]
                          : current.filter((id) => id !== option.id));
                        clearResult();
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" disabled={preview.kind === "loading"}>
              {preview.kind === "loading" ? "Previewing" : "Preview"}
            </button>
          </div>
        </form>
        <ProposalPreviewPane
          preview={preview}
          stage={stage}
          onRetry={(request) => { void loadPreview(request); }}
          onStage={(request, result) => { void stageTask(request, result); }}
        />
      </div>
    </main>
  );
}

type Interview = Readonly<{
  objective: string;
  workType: TeamWorkType | "";
  completionEvidence: string;
  constraints: string;
  capabilities: readonly CapabilityFact["id"][];
}>;

function buildRequest(interview: Interview): TeamProposalRequestV1 {
  const evidence = normalizedLines(interview.completionEvidence);
  const constraints = normalizedLines(interview.constraints);
  return {
    schema_version: 1,
    objective: interview.objective.trim(),
    ...(interview.workType === "" ? {} : { work_type: interview.workType }),
    ...(evidence.length === 0 ? {} : { completion_evidence: evidence }),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(interview.capabilities.length === 0 ? {} : { requested_capabilities: interview.capabilities }),
  };
}

function normalizedLines(value: string): readonly string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseWorkType(value: string): TeamWorkType | "" {
  switch (value) {
    case "research":
    case "development":
    case "analysis":
    case "content":
    case "product":
      return value;
    default:
      return "";
  }
}

function parseDigest(value: string): Sha256Digest | undefined {
  const prefix = "sha256:";
  if (!value.startsWith(prefix)) return undefined;
  const digest = value.slice(prefix.length);
  return /^[0-9a-f]{64}$/.test(digest) ? `sha256:${digest}` : undefined;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function isMutationError(error: unknown): error is DashboardApiError | TypeError | DOMException {
  return error instanceof DashboardApiError || error instanceof TypeError || error instanceof DOMException;
}
