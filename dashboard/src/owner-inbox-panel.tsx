import { useEffect, useState } from "react";
import { actionLabel, formatKst } from "./copy.js";
import { OwnerInboxEnroll } from "./owner-inbox-enroll.js";
import { inboxExecutionOutcome, inboxOutcomeText, type InboxExecution } from "./owner-inbox-outcome.js";
import { useSurface } from "./surface.js";

type Item = Readonly<{
  request_id: string;
  action: string;
  summary: string;
  command_digest: string;
  expires_at: string;
  expired?: boolean;
  manual_wait?: boolean;
  needs_review?: boolean;
  failure_code?: string | null;
  state?: string;
  batch_items?: readonly BatchLine[];
  requester_label?: string;
  company_candidate?: Readonly<{
    provider_instance_id: string; workspace_id: string; candidate_id: string;
    content_digest: string; owner: string; projects: readonly string[];
    policy_revision: string; deletion_sequence: number; deletion_set_root: string;
    processor_principal_id: string; status: string;
  }>;
}>;

type BatchLine = Readonly<{
  action_kind: string;
  summary: string;
  payload_digest: string;
  mail_to?: string;
  mail_subject?: string;
}>;

const KIND_LABEL: Readonly<Record<string, string>> = {
  "mail.send": "메일 발송",
  "notion.write": "노션 기록",
  "tax.transmit": "세금 전송",
  "payment": "결제",
};

type Status = "loading" | "ready" | "error" | "unconfigured";

export function OwnerInboxPanel() {
  const phone = useSurface() === "phone";
  const [items, setItems] = useState<readonly Item[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const [outcome, setOutcome] = useState<{ state: string; failure_code?: string } | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(true);

  async function load(): Promise<void> {
    setStatus("loading");
    try {
      const csrf = await csrfToken(phone);
      const response = await fetch("/api/v1/owner-inbox", {
        headers: { Accept: "application/json", "X-JARVIS-CSRF": csrf },
        credentials: "same-origin",
      });
      if (response.status === 503) {
        setStatus("unconfigured");
        return;
      }
      if (!response.ok) {
        setStatus("error");
        return;
      }
      const body = await response.json() as { items?: Item[]; passkey_enrolled?: boolean };
      setItems(body.items ?? []);
      setPasskeyEnrolled(body.passkey_enrolled === true);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => { void load(); }, [phone]);

  async function decide(item: Item, decision: "approve" | "reject"): Promise<void> {
    const confirmed = window.confirm(decision === "approve"
      ? item.company_candidate ? "이 회사 후보의 수락과 완료 증거 확인 후 처리를 패스키로 승인합니다."
        : "이 묶음 전체를 Face ID 한 번으로 승인합니다."
      : item.company_candidate ? "이 회사 후보를 거절합니다." : "이 묶음 전체를 거절합니다.");
    if (!confirmed) return;
    if (typeof navigator.credentials?.get !== "function") {
      setNotice("이 기기에는 패스키가 없습니다. 휴대폰에서 한 번 등록한 뒤에만 승인할 수 있습니다.");
      return;
    }
    setBusyId(item.request_id);
    setNotice("");
    try {
      const csrf = await csrfToken(phone);
      const challengeResponse = await fetch("/api/v1/owner-inbox/challenge", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-JARVIS-CSRF": csrf },
        body: JSON.stringify({
          schema_version: 1,
          request_id: item.request_id,
          decision,
          command_digest: item.command_digest,
        }),
      });
      if (!challengeResponse.ok) {
        setNotice("패스키 확인을 시작하지 못했습니다.");
        return;
      }
      const challengeBody = await challengeResponse.json() as { challenge_id?: string; challenge?: string };
      if (typeof challengeBody.challenge !== "string" || typeof challengeBody.challenge_id !== "string") {
        setNotice("패스키 확인을 시작하지 못했습니다.");
        return;
      }
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: Uint8Array.from(bytesFrom(challengeBody.challenge)).buffer,
          timeout: 60_000,
          userVerification: "required",
        },
      });
      if (!(assertion instanceof PublicKeyCredential) || !(assertion.response instanceof AuthenticatorAssertionResponse)) {
        setNotice("패스키 확인이 취소되었습니다.");
        return;
      }
      const response = await fetch("/api/v1/owner-inbox/decide", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-JARVIS-CSRF": csrf },
        body: JSON.stringify({
          schema_version: 1,
          request_id: item.request_id,
          decision,
          command_digest: item.command_digest,
          challenge_id: challengeBody.challenge_id,
          assertion: {
            id: assertion.id,
            clientDataJSON: textFrom(assertion.response.clientDataJSON),
            authenticatorData: textFrom(assertion.response.authenticatorData),
            signature: textFrom(assertion.response.signature),
            userHandle: assertion.response.userHandle === null ? "" : textFrom(assertion.response.userHandle),
          },
        }),
      });
      if (!response.ok) {
        setNotice("패스키 확인 뒤에만 처리됩니다.");
        return;
      }
      const decided = await response.json() as { execution?: InboxExecution };
      const outcome = inboxExecutionOutcome(decision, decided.execution);
      setOutcome(outcome);
      setNotice(inboxOutcomeText(outcome, item.action));
      await load();
    } catch {
      setNotice("패스키 확인 뒤에만 처리됩니다.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="panel" aria-labelledby="owner-inbox-title">
      <header className="panel-header"><h2 id="owner-inbox-title">승인함</h2></header>
      <div className="panel-body">
        {status === "loading" ? <p role="status">승인을 불러오는 중</p> : null}
        {status === "error" ? <p role="alert">승인함을 열 수 없습니다. <button type="button" onClick={() => { void load(); }}>다시 시도</button></p> : null}
        {status === "unconfigured" ? <p role="status">이 화면에서는 서명 키가 연결되어 있지 않습니다.</p> : null}
        {status === "ready" && !passkeyEnrolled ? (
          <OwnerInboxEnroll csrf={() => csrfToken(phone)} />
        ) : null}
        {status === "ready" && items.length === 0 ? <p className="empty-state">대기 중인 승인이 없습니다</p> : null}
        {notice.length > 0 ? <p role="status" data-execution-state={outcome?.state} data-failure-code={outcome?.failure_code}>{notice}</p> : null}
        {items.some(item => item.needs_review) ? (
          <section data-section="needs-review">
            <h3>결과 확인 필요</h3>
            <ul className="record-list">
              {items.filter(item => item.needs_review).map(item => (
                <li className="record" key={item.request_id} data-request-state={item.state} data-failure-code={item.failure_code ?? ""}>
                  <p className="record-title">{item.summary}</p>
                  <p className="record-meta">{actionLabel(item.action)}</p>
                  {item.company_candidate ? <CompanyDetails item={item.company_candidate} /> : null}
                  <Digest value={item.command_digest} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <ul className="record-list">
          {items.filter(item => !item.needs_review).map(item => (
            <li className="record" key={item.request_id}>
              {item.requester_label ? <p className="record-title" data-requester={item.requester_label}>{item.requester_label}</p> : null}
              <p className="record-title">{item.batch_items && item.batch_items.length > 0 ? `윤비서 요청 · ${item.batch_items.length}건 묶음 · 30분 내 승인` : item.summary}</p>
              {item.batch_items && item.batch_items.length > 0 ? <BatchLines items={item.batch_items} /> : null}
              {item.company_candidate ? <CompanyDetails item={item.company_candidate} /> : null}
              {item.expired ? <p className="record-meta">만료됨. 이 요청은 더 이상 승인할 수 없습니다.</p> : null}
              <p className="record-meta">{actionLabel(item.action)}</p>
              <p className="record-meta"><time dateTime={item.expires_at}>유효 {formatKst(item.expires_at)}</time></p>
              <Digest value={item.command_digest} />
              {item.expired || item.manual_wait ? null : (
                <>
                  <p className="record-meta">{item.company_candidate
                    ? "이 후보만 패스키로 승인합니다. 수락은 완료가 아니며 별도 처리기가 완료 증거를 확인합니다."
                    : "이 묶음은 Face ID 한 번으로 승인됩니다."}</p>
                  <button type="button" disabled={busyId === item.request_id} onClick={() => { void decide(item, "approve"); }}>승인</button>
                  <button type="button" disabled={busyId === item.request_id} onClick={() => { void decide(item, "reject"); }}>거절</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CompanyDetails({ item }: Readonly<{ item: NonNullable<Item["company_candidate"]> }>) {
  return (
    <details className="digest">
      <summary className="record-meta">회사 후보·승인 범위 확인</summary>
      <dl className="identity-list">
        {Object.entries(item).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : value}</dd></div>
        ))}
      </dl>
    </details>
  );
}

function BatchLines({ items }: Readonly<{ items: readonly BatchLine[] }>) {
  const [open, setOpen] = useState(items.length <= 6);
  const shown = open ? items : items.slice(0, 3);
  return (
    <>
      <ol className={open && items.length > 6 ? "batch-list expanded" : "batch-list"} data-batch="true">
        {shown.map((batch, index) => (
          <li key={index} data-item-index={index}>
            <strong>{KIND_LABEL[batch.action_kind] ?? "외부 요청"}</strong>
            {batch.action_kind === "mail.send" ? (
              <p className="record-meta">확인된 초안 · {batch.summary}</p>
            ) : (
              <p className="record-meta">윤비서 작성 요약 · {batch.summary}</p>
            )}
          </li>
        ))}
      </ol>
      {items.length > 6 ? (
        <button type="button" onClick={() => { setOpen(value => !value); }}>
          {open ? "접기" : `나머지 ${items.length - 3}건 보기`}
        </button>
      ) : null}
    </>
  );
}

function Digest({ value }: Readonly<{ value: string }>) {
  const short = value.length <= 12 ? value : `${value.slice(0, 12)}…`;
  return (
    <details className="digest">
      <summary className="record-meta" title={value}>{short}</summary>
      <p className="record-meta digest-full">{value}</p>
    </details>
  );
}

function bytesFrom(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function textFrom(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function csrfToken(phone: boolean): Promise<string> {
  const path = phone ? "/api/v1/phone/session" : "/api/v1/session";
  const response = await fetch(path, { credentials: "same-origin" });
  const body = await response.json() as { csrf_token?: string };
  if (!response.ok || typeof body.csrf_token !== "string") throw new Error("session");
  return body.csrf_token;
}
