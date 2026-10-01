import { useEffect, useState } from "react";
import { actionLabel, formatKst } from "./copy.js";
import { OwnerInboxEnroll } from "./owner-inbox-enroll.js";
import { useSurface } from "./surface.js";

type Item = Readonly<{
  request_id: string;
  action: string;
  summary: string;
  command_digest: string;
  expires_at: string;
  expired?: boolean;
}>;

type Status = "loading" | "ready" | "error" | "unconfigured";

export function OwnerInboxPanel() {
  const phone = useSurface() === "phone";
  const [items, setItems] = useState<readonly Item[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
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
    const confirmed = window.confirm(`${decision === "approve" ? "이 요청만 승인합니다." : "이 요청만 거절합니다."}\n${item.summary}\n${item.command_digest}`);
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
      setNotice(response.ok ? (decision === "approve" ? "승인했습니다." : "거절했습니다.") : "패스키 확인 뒤에만 처리됩니다.");
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
        {notice.length > 0 ? <p role="status">{notice}</p> : null}
        <ul className="record-list">
          {items.map(item => (
            <li className="record" key={item.request_id}>
              <p className="record-title">{item.summary}</p>
              {item.expired ? <p className="record-meta">만료됨. 이 요청은 더 이상 승인할 수 없습니다.</p> : null}
              <p className="record-meta">{actionLabel(item.action)}</p>
              <p className="record-meta"><time dateTime={item.expires_at}>유효 {formatKst(item.expires_at)}</time></p>
              <Digest value={item.command_digest} />
              {item.expired ? null : (
                <>
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
