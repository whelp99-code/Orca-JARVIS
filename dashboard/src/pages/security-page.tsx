import { useState } from "react";
import "../styles/security.css";
import { gatewayOrigin } from "../webauthn-ceremony.js";

export type SecurityCredential = {
  readonly credential_id_prefix: string;
  readonly state: string;
};

export type SecurityClient = {
  readonly listCredentials: () => Promise<{ readonly items: readonly SecurityCredential[] }>;
  readonly beginEnrollment: () => Promise<{ readonly enrollment_id: string; readonly request_id?: string }>;
  readonly registerPasskey: (enrollmentId: string, beginRequestId: string) => Promise<{ readonly credential_id: string; readonly activation_request_id: string }>;
  readonly stageRevocation: (credentialId: string) => Promise<{ readonly request_id: string }>;
  readonly loadRequest: (requestId: string) => Promise<{
    readonly request_id: string; readonly action: string; readonly action_level: number;
    readonly command_digest: string; readonly target_digest: string; readonly args_digest: string;
    readonly requested_at: string; readonly expires_at: string; readonly status: string;
    readonly target: unknown; readonly args: unknown;
  }>;
  readonly decideRemote: (requestId: string, decision: "approve" | "reject") => Promise<{
    readonly challenge_id: string; readonly outcome?: string; readonly receipt_id?: string;
  }>;
};

export type SecurityPageProps = Readonly<{
  client: SecurityClient;
  enrollmentOrigin?: "local" | "gateway";
}>;

export function SecurityPage({ client, enrollmentOrigin = gatewayOrigin() ? "gateway" : "local" }: SecurityPageProps) {
  const [requestId, setRequestId] = useState("");
  const [enrollmentId, setEnrollmentId] = useState("");
  const [beginRequestId, setBeginRequestId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [credentials, setCredentials] = useState<readonly SecurityCredential[]>([]);
  const [review, setReview] = useState<Awaited<ReturnType<SecurityClient["loadRequest"]>> | null>(null);
  const [status, setStatus] = useState("Passkeys stay on this device. Linux verifies and mints the receipt.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const localEnrollment = enrollmentOrigin === "local";

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
    <section className="page-frame dashboard-main security-page" aria-label="Security" data-enrollment-origin={enrollmentOrigin}>
      <h1>보안</h1>
      <p className="security-lead">Remote approval requires a passkey assertion. A session cookie is never enough.</p>
      <p className="security-note" role="note">Passkey enrollment starts only in the local owner session. Remote self-enrollment has no authority.</p>
      <p className="security-status" role="status">{status}</p>
      {error === null ? null : <p className="security-alert" role="alert">{error}</p>}

      <section className="panel" aria-labelledby="enroll-title">
        <h2 id="enroll-title">Owner passkey</h2>
        {localEnrollment ? null : <p role="status">Enrollment is unavailable on the gateway origin.</p>}
        <button type="button" className="security-action" disabled={busy || !localEnrollment} onClick={() => {
          void run(async () => {
            const began = await client.beginEnrollment();
            setEnrollmentId(began.enrollment_id);
            setBeginRequestId(began.request_id ?? "");
            setStatus(`Enrollment staged ${began.enrollment_id}`);
          });
        }}>Begin enrollment</button>
        <label className="security-label">
          Enrollment ID
          <input value={enrollmentId} onChange={event => setEnrollmentId(event.target.value)} autoComplete="off" />
        </label>
        <label className="security-label">
          Begin request ID
          <input value={beginRequestId} onChange={event => setBeginRequestId(event.target.value)} autoComplete="off" />
        </label>
        <button type="button" className="security-action" disabled={busy || enrollmentId.length === 0 || beginRequestId.length === 0} onClick={() => {
          void run(async () => {
            const registered = await client.registerPasskey(enrollmentId, beginRequestId);
            setCredentialId(registered.credential_id);
            setStatus(`Passkey registered ${registered.credential_id}. Activation ${registered.activation_request_id} waits for the local owner receipt.`);
          });
        }}>Register passkey</button>
        <button type="button" className="security-action" disabled={busy} onClick={() => {
          void run(async () => {
            const listed = await client.listCredentials();
            setCredentials(listed.items);
            setStatus(listed.items.length === 0 ? "No passkeys" : `Listed ${String(listed.items.length)} passkeys`);
          });
        }}>Refresh credentials</button>
        {credentials.length === 0 ? <p className="empty-state">No passkeys listed</p> : (
          <ul className="security-credentials">
            {credentials.map(item => (
              <li key={item.credential_id_prefix}><span className="mono">{item.credential_id_prefix}</span> {item.state}</li>
            ))}
          </ul>
        )}
        <label className="security-label">
          Credential ID
          <input value={credentialId} onChange={event => setCredentialId(event.target.value)} autoComplete="off" />
        </label>
        <button type="button" className="security-action" disabled={busy || !localEnrollment || credentialId.length === 0} onClick={() => {
          void run(async () => {
            const staged = await client.stageRevocation(credentialId);
            setStatus(`Revocation staged ${staged.request_id}`);
          });
        }}>Stage revocation</button>
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
              setStatus(decided.outcome === undefined ? `Challenge ${decided.challenge_id}` : `Decision ${decided.outcome}`);
            });
          }}>Approve</button>
          <button type="button" className="security-action" disabled={busy || review === null} onClick={() => {
            void run(async () => {
              if (review === null) return;
              const decided = await client.decideRemote(review.request_id, "reject");
              setStatus(decided.outcome === undefined ? `Challenge ${decided.challenge_id}` : `Decision ${decided.outcome}`);
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


export { createBrowserSecurityClient } from "../security-client.js";
