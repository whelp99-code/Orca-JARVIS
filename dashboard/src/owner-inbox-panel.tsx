import { useEffect, useState } from "react";
import { formatKst } from "./copy.js";
import { useSurface } from "./surface.js";

type Item = Readonly<{
  request_id: string;
  action: string;
  summary: string;
  command_digest: string;
  expires_at: string;
}>;

type Status = "loading" | "ready" | "error" | "unconfigured";

export function OwnerInboxPanel() {
  const phone = useSurface() === "phone";
  const [items, setItems] = useState<readonly Item[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | undefined>();

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
      const body = await response.json() as { items?: Item[] };
      setItems(body.items ?? []);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => { void load(); }, [phone]);

  async function decide(item: Item, decision: "approve" | "reject"): Promise<void> {
    const confirmed = window.confirm(`${decision === "approve" ? "이 요청만 승인합니다." : "이 요청만 거절합니다."}\n${item.summary}\n${item.command_digest}`);
    if (!confirmed) return;
    setBusyId(item.request_id);
    setNotice("");
    try {
      const csrf = await csrfToken(phone);
      const response = await fetch("/api/v1/owner-inbox/decide", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-JARVIS-CSRF": csrf },
        body: JSON.stringify({
          request_id: item.request_id,
          decision,
          command_digest: item.command_digest,
        }),
      });
      setNotice(response.ok ? (decision === "approve" ? "승인했습니다." : "거절했습니다.") : "처리하지 못했습니다. 다시 확인하세요.");
      await load();
    } catch {
      setNotice("처리하지 못했습니다. 다시 확인하세요.");
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
        {status === "ready" && items.length === 0 ? <p className="empty-state">대기 중인 승인이 없습니다</p> : null}
        {notice.length > 0 ? <p role="status">{notice}</p> : null}
        <ul className="record-list">
          {items.map(item => (
            <li className="record" key={item.request_id}>
              <p className="record-title">{item.summary}</p>
              <p className="record-meta">{item.action}</p>
              <p className="record-meta"><time dateTime={item.expires_at}>유효 {formatKst(item.expires_at)}</time></p>
              <p className="record-meta">{item.command_digest}</p>
              <button type="button" disabled={busyId === item.request_id} onClick={() => { void decide(item, "approve"); }}>승인</button>
              <button type="button" disabled={busyId === item.request_id} onClick={() => { void decide(item, "reject"); }}>거절</button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

async function csrfToken(phone: boolean): Promise<string> {
  const path = phone ? "/api/v1/phone/session" : "/api/v1/session";
  const response = await fetch(path, { credentials: "same-origin" });
  const body = await response.json() as { csrf_token?: string };
  if (!response.ok || typeof body.csrf_token !== "string") throw new Error("session");
  return body.csrf_token;
}
