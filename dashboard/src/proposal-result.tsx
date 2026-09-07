import type { StoredControlCommand } from "../../src/control-plane.js";
import type { CreateTaskRequest } from "../../src/dashboard/contracts.js";
import type { TeamProposalRequestV1, TeamProposalResultV1 } from "../../src/team-proposal.js";

export type PreviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly request: TeamProposalRequestV1 }
  | { readonly kind: "error"; readonly request: TeamProposalRequestV1 }
  | {
      readonly kind: "complete";
      readonly request: TeamProposalRequestV1;
      readonly result: TeamProposalResultV1;
    };

export type StageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "success";
      readonly command: StoredControlCommand;
      readonly task: CreateTaskRequest;
    };

type ProposalResultProps = Readonly<{
  result: TeamProposalResultV1;
  stage: StageState;
  onStage: () => void;
}>;

const TOTAL_ATTEMPTS = 30;

export function ProposalPreviewPane({ preview, stage, onRetry, onStage }: Readonly<{
  preview: PreviewState;
  stage: StageState;
  onRetry: (request: TeamProposalRequestV1) => void;
  onStage: (
    request: TeamProposalRequestV1,
    result: Extract<TeamProposalResultV1, { readonly status: "ready" }>,
  ) => void;
}>) {
  switch (preview.kind) {
    case "idle":
      return <p className="panel empty-state proposal-result">Complete the interview to preview a team.</p>;
    case "loading":
      return <p className="panel empty-state proposal-result" role="status">Planning proposal</p>;
    case "error":
      return (
        <section className="panel proposal-result proposal-error" role="alert">
          <p>Unable to preview proposal</p>
          <button type="button" onClick={() => onRetry(preview.request)}>Retry</button>
        </section>
      );
    case "complete":
      return (
        <ProposalResult
          result={preview.result}
          stage={stage}
          onStage={() => {
            if (preview.result.status === "ready") onStage(preview.request, preview.result);
          }}
        />
      );
    default:
      return assertNever(preview);
  }
}

function ProposalResult({ result, stage, onStage }: ProposalResultProps) {
  switch (result.status) {
    case "needs_input":
      return (
        <section className="panel proposal-result" aria-label="More information needed">
          <header className="panel-header"><h2>More information needed</h2></header>
          <ul className="record-list">
            {result.questions.map((question) => (
              <li className="record" key={question.id}>{question.text}</li>
            ))}
          </ul>
        </section>
      );
    case "blocked":
      return (
        <section className="panel proposal-result proposal-blocked" role="alert">
          <header className="panel-header"><h2>Proposal blocked</h2></header>
          <ul className="record-list">
            {result.reasons.map((reason) => (
              <li className="record" key={`${reason.capability_id}:${reason.stage}`}>
                {reason.capability_id}: {reason.stage}
              </li>
            ))}
          </ul>
        </section>
      );
    case "ready":
      return <ReadyProposal result={result} stage={stage} onStage={onStage} />;
    default:
      return assertNever(result);
  }
}

function ReadyProposal({ result, stage, onStage }: Readonly<{
  result: Extract<TeamProposalResultV1, { readonly status: "ready" }>;
  stage: StageState;
  onStage: () => void;
}>) {
  const warnings = Array.from(new Set(result.members.flatMap((member) => (
    member.exclusions.map(exclusionWarning).filter(isDefined)
  ))));
  return (
    <section className="panel proposal-result" aria-label="Proposal preview">
      <header className="panel-header proposal-result-header">
        <h2>Proposal preview</h2>
        <p className="proposal-status" role="status" aria-label="Proposal status">Ready</p>
      </header>
      <div className="proposal-result-body">
        <dl className="identity-list proposal-summary">
          <div><dt>Objective</dt><dd>{result.objective}</dd></div>
          <div><dt>Digest</dt><dd>{result.proposal_digest}</dd></div>
        </dl>
        <section aria-label="Work requirements">
          <h3>Work requirements</h3>
          <p>{result.requirements.work_type}</p>
          <h4>Constraints</h4>
          {result.requirements.constraints.length === 0 ? <p>No additional constraints supplied</p> : (
            <ul>{result.requirements.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>
          )}
          <h4>Completion evidence</h4>
          <ul>{result.requirements.completion_evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>
        </section>
        <section aria-label="Selected members">
          <h3>Selected members</h3>
          <ul className="record-list proposal-members">
            {result.members.map((member) => (
              <li className="record" key={member.member_id}>
                <p className="record-title">{member.member_id}</p>
                <p className="record-summary">{member.role}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="proposal-warnings" aria-label="Warnings">
          <h3>Warnings</h3>
          {warnings.length === 0 ? (
            <p className="record-summary">No proposal exclusions</p>
          ) : (
            <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          )}
        </section>
        <p className="proposal-budget" role="status" aria-label="Total budget">
          {TOTAL_ATTEMPTS} attempts total
        </p>
        <button type="button" disabled={stage.kind === "loading"} onClick={onStage}>
          {stage.kind === "loading" ? "Staging task" : "Stage task"}
        </button>
        {stage.kind === "error" ? <p className="proposal-error" role="alert">Unable to stage task</p> : null}
        {stage.kind === "success" ? <StagedRequest command={stage.command} task={stage.task} /> : null}
      </div>
    </section>
  );
}

function StagedRequest({ command, task }: Readonly<{
  command: StoredControlCommand;
  task: CreateTaskRequest;
}>) {
  return (
    <section className="staged-request" aria-label="Staged request">
      <h3>Pending request</h3>
      <dl className="identity-list">
        <div><dt>Request</dt><dd>{command.request_id}</dd></div>
        <div><dt>Action</dt><dd>{command.action}</dd></div>
        <div><dt>State</dt><dd>{command.state}</dd></div>
        <div><dt>Loop</dt><dd>agentops-default</dd></div>
        <div><dt>Task</dt><dd>{task.task_id}</dd></div>
      </dl>
    </section>
  );
}

function exclusionWarning(exclusion: string): string | undefined {
  switch (exclusion) {
    case "grant_authority":
      return "Cannot grant authority";
    case "persist_proposal":
      return "Cannot persist proposal";
    default:
      return undefined;
  }
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected proposal status: ${JSON.stringify(value)}`);
}
