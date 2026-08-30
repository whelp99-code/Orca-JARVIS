import { useState } from "react";
import { DashboardApiError } from "./api.js";
import type { DecisionItem, PersonalClient, RecommendationDetail, ContextEvidence } from "./personal-api.js";

type Props = Readonly<{
  decision: DecisionItem;
  client: PersonalClient;
  actionable: boolean;
  onSettled: () => void;
}>;
type AcceptState = "idle" | "loading" | "accepted" | "error";
type EvidenceState =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly detail: RecommendationDetail; readonly context: ContextEvidence };

export function RecommendationAction({ decision, client, actionable, onSettled }: Props) {
  const [acceptState, setAcceptState] = useState<AcceptState>("idle");
  const [evidenceState, setEvidenceState] = useState<EvidenceState>({ kind: "idle" });
  const disabled = !actionable || acceptState !== "idle";

  async function accept(): Promise<void> {
    if (disabled) return;
    setAcceptState("loading");
    try {
      await client.accept(decision.recommendation_id, decision.rank);
      setAcceptState("accepted");
      onSettled();
    } catch (error: unknown) {
      if (!(error instanceof DashboardApiError || error instanceof TypeError || error instanceof DOMException)) throw error;
      setAcceptState("error");
    }
  }

  async function loadEvidence(): Promise<void> {
    if (evidenceState.kind === "loading" || evidenceState.kind === "ready") return;
    setEvidenceState({ kind: "loading" });
    try {
      const detail = await client.recommendation(decision.recommendation_id);
      const context = await client.evidence(detail.context_evidence_link);
      setEvidenceState({ kind: "ready", detail, context });
    } catch (error: unknown) {
      if (!(error instanceof DashboardApiError || error instanceof TypeError || error instanceof DOMException)) throw error;
      setEvidenceState({ kind: "error" });
    }
  }

  return (
    <article className="decision-action">
      <h3 className="record-title">{decision.title}</h3>
      <div className="record-meta">
        <span>Rank {decision.rank}</span>
        <span>{decision.confidence_class}</span>
        <span>{decision.state}</span>
        <time dateTime={decision.expires_at}>{decision.expires_at}</time>
      </div>
      <details>
        <summary>Evidence and citations</summary>
        <div className="evidence-body">
          <ul className="citation-list">
            {decision.citations.map((citation) => (
              <li key={`${citation.kind}:${citation.ref}`}>{citation.kind}: {citation.ref}</li>
            ))}
          </ul>
          <button type="button" disabled={evidenceState.kind === "loading"} onClick={() => { void loadEvidence(); }}>
            {evidenceState.kind === "loading" ? "Loading evidence" : "Load exact evidence"}
          </button>
          <EvidenceResult state={evidenceState} />
        </div>
      </details>
      <button type="button" disabled={disabled} onClick={() => { void accept(); }} aria-label={`Accept action ${decision.rank}`}>
        {acceptState === "loading" ? "Staging action" : acceptState === "accepted" ? "Action staged" : "Accept action"}
      </button>
      {acceptState === "error" ? <p role="alert" className="control-error">Recommendation action unavailable</p> : null}
      {acceptState === "accepted" ? <p role="status" className="control-status">Pending workflow request staged</p> : null}
    </article>
  );
}

function EvidenceResult({ state }: Readonly<{ state: EvidenceState }>) {
  switch (state.kind) {
    case "idle":
    case "loading":
      return null;
    case "error":
      return <p role="alert" className="control-error">Evidence unavailable</p>;
    case "ready":
      return (
        <div className="evidence-result" role="status">
          <p>Recommendation {state.detail.lifecycle_state}; context {state.context.state}</p>
          <ul className="record-list">
            {state.context.evidence.map((item) => (
              <li className="record" key={item.evidence_id}>
                <p className="record-title">{item.kind}</p>
                <div className="record-meta">
                  <span>{item.source_id}</span>
                  <time dateTime={item.observed_at}>{item.observed_at}</time>
                  <span>{item.digest}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      );
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected evidence state: ${JSON.stringify(value)}`);
}
