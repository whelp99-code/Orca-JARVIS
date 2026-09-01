import { useState } from "react";
import "../styles/security.css";

export type SecurityClient = {
  readonly listCredentials: () => Promise<{ readonly items: readonly { readonly credential_id_prefix: string; readonly state: string }[] }>;
  readonly beginEnrollment: () => Promise<{ readonly enrollment_id: string }>;
  readonly loadRequest: (requestId: string) => Promise<{
    readonly request_id: string; readonly action: string; readonly action_level: number;
    readonly command_digest: string; readonly target_digest: string; readonly args_digest: string;
    readonly requested_at: string; readonly expires_at: string; readonly status: string;
    readonly target: unknown; readonly args: unknown;
  }>;
  readonly decideRemote: (requestId: string, decision: "approve" | "reject") => Promise<{ readonly challenge_id: string }>;
};

export type SecurityPageProps = Readonly<{
  client: SecurityClient;
}>;

export function SecurityPage({ client }: SecurityPageProps) {
  const [requestId, setRequestId] = useState("");
  const [review, setReview] = useState<Awaited<ReturnType<SecurityClient["loadRequest"]>> | null>(null);
  const [status, setStatus] = useState("Passkeys stay on this device. Linux verifies and mints the receipt.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Remote approval unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-frame dashboard-main security-page" aria-label="Security">
      <h1>보안</h1>
      <p className="security-lead">Remote approval requires a passkey assertion. A session cookie is never enough.</p>
      <p className="security-status" role="status">{status}</p>
      {error === null ? null : <p className="security-alert" role="alert">{error}</p>}

      <section className="panel" aria-labelledby="enroll-title">
        <h2 id="enroll-title">Owner passkey</h2>
        <button type="button" className="security-action" disabled={busy} onClick={() => {
          void run(async () => {
            const began = await client.beginEnrollment();
            setStatus(`Enrollment staged ${began.enrollment_id}`);
          });
        }}>Begin enrollment</button>
      </section>

      <section className="panel" aria-labelledby="review-title">
        <h2 id="review-title">Remote command</h2>
        <label className="security-label">
          Request ID
          <input value={requestId} onChange={event => setRequestId(event.target.value)} autoComplete="off" />
        </label>
        <div className="security-actions">
          <button type="button" className="security-action" disabled={busy || requestId.length === 0} onClick={() => {
            void run(async () => {
              const loaded = await client.loadRequest(requestId);
              setReview(loaded);
              setStatus(`Loaded ${loaded.request_id}`);
            });
          }}>Load</button>
          <button type="button" className="security-action" disabled={busy || review === null} onClick={() => {
            void run(async () => {
              if (review === null) return;
              const decided = await client.decideRemote(review.request_id, "approve");
              setStatus(`Challenge ${decided.challenge_id}`);
            });
          }}>Approve</button>
          <button type="button" className="security-action" disabled={busy || review === null} onClick={() => {
            void run(async () => {
              if (review === null) return;
              const decided = await client.decideRemote(review.request_id, "reject");
              setStatus(`Challenge ${decided.challenge_id}`);
            });
          }}>Reject</button>
        </div>
        {review === null ? <p className="empty-state">No command loaded</p> : (
          <dl className="security-review">
            <div><dt>Action</dt><dd className="mono">{review.action}</dd></div>
            <div><dt>Level</dt><dd className="mono">{review.action_level}</dd></div>
            <div><dt>Command</dt><dd className="mono">{review.command_digest}</dd></div>
            <div><dt>Target</dt><dd className="mono">{review.target_digest}</dd></div>
            <div><dt>Args</dt><dd className="mono">{review.args_digest}</dd></div>
            <div><dt>Requested</dt><dd><time dateTime={review.requested_at}>{review.requested_at}</time></dd></div>
            <div><dt>Expires</dt><dd><time dateTime={review.expires_at}>{review.expires_at}</time></dd></div>
          </dl>
        )}
      </section>
    </section>
  );
}

export function createBrowserSecurityClient(): SecurityClient {
  return {
    async listCredentials() {
      return { items: [] };
    },
    async beginEnrollment() {
      const session = await (await fetch("/api/v1/session")).json() as { csrf_token: string };
      const response = await fetch("/api/v1/security/webauthn/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-jarvis-csrf": session.csrf_token },
        body: JSON.stringify({ schema_version: 1 }),
      });
      const body = await response.json() as { enrollment_id?: string; error?: { message: string } };
      if (!response.ok || body.enrollment_id === undefined) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return { enrollment_id: body.enrollment_id };
    },
    async loadRequest(requestId) {
      const response = await fetch(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}`);
      const body = await response.json() as Awaited<ReturnType<SecurityClient["loadRequest"]>> & { error?: { message: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return body;
    },
    async decideRemote(requestId, decision) {
      const response = await fetch(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision }),
      });
      const body = await response.json() as { challenge_id?: string; error?: { message: string } };
      if (!response.ok || body.challenge_id === undefined) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return { challenge_id: body.challenge_id };
    },
  };
}
