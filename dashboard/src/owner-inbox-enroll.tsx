import { useState } from "react";

const DEVICE_KEY = "jarvis.owner-inbox.passkey";

export function deviceHasInboxPasskey(): boolean {
  try {
    return localStorage.getItem(DEVICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markDeviceInboxPasskey(): void {
  localStorage.setItem(DEVICE_KEY, "1");
}

export function enrollErrorMessage(code: string | undefined): string {
  switch (code) {
    case "OWNER_INBOX_EXPIRED": return "등록 코드가 만료되었습니다.";
    case "OWNER_INBOX_REPLAY": return "이미 사용한 등록 코드입니다.";
    case "OWNER_INBOX_ORIGIN_MISMATCH": return "다른 주소에서 접속 중입니다. 등록한 주소에서 다시 여세요.";
    case "OWNER_INBOX_IDENTITY_REQUIRED": return "등록 코드가 틀렸습니다.";
    case "OWNER_INBOX_WEBAUTHN_REQUIRED":
    case "OWNER_INBOX_ASSERTION_REJECTED": return "패스키 등록이 거부되었습니다.";
    default: return "패스키를 등록하지 못했습니다.";
  }
}

export function OwnerInboxEnroll({ csrf }: { readonly csrf: () => Promise<string> }) {
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const [alert, setAlert] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(deviceHasInboxPasskey());

  async function register(): Promise<void> {
    setAlert("");
    setNotice("");
    if (code.trim().length === 0) {
      setAlert("등록 코드를 입력하세요.");
      return;
    }
    if (typeof navigator.credentials?.create !== "function") {
      setAlert("이 브라우저는 패스키 등록을 지원하지 않습니다.");
      return;
    }
    setBusy(true);
    try {
      const token = await csrf();
      const optionsResponse = await fetch("/api/v1/owner-inbox/enroll", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-JARVIS-CSRF": token },
        body: JSON.stringify({ schema_version: 1, enrollment_code: code.trim(), phase: "options" }),
      });
      if (!optionsResponse.ok) {
        setAlert(enrollErrorMessage(await errorCode(optionsResponse)));
        return;
      }
      const options = await optionsResponse.json() as {
        challenge?: string;
        rp?: { id: string; name: string };
        user?: { id: string; name: string; displayName: string };
        pubKeyCredParams?: PublicKeyCredentialParameters[];
        timeout?: number;
        authenticatorSelection?: AuthenticatorSelectionCriteria;
      };
      if (typeof options.challenge !== "string" || options.rp === undefined || options.user === undefined) {
        setAlert("패스키 등록을 시작하지 못했습니다.");
        return;
      }
      const created = await navigator.credentials.create({
        publicKey: {
          challenge: bytesFrom(options.challenge),
          rp: options.rp,
          user: { id: bytesFrom(options.user.id), name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: options.pubKeyCredParams ?? [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }],
          timeout: options.timeout ?? 60_000,
          attestation: "none",
          authenticatorSelection: options.authenticatorSelection ?? { residentKey: "required", userVerification: "required" },
        },
      });
      if (!(created instanceof PublicKeyCredential) || !(created.response instanceof AuthenticatorAttestationResponse)) {
        setAlert("패스키 등록이 취소되었습니다.");
        return;
      }
      const enrolled = await fetch("/api/v1/owner-inbox/enroll", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-JARVIS-CSRF": token },
        body: JSON.stringify({
          schema_version: 1,
          enrollment_code: code.trim(),
          attestation: {
            id: created.id,
            clientDataJSON: textFrom(created.response.clientDataJSON),
            attestationObject: textFrom(created.response.attestationObject),
          },
        }),
      });
      if (!enrolled.ok) {
        setAlert(enrollErrorMessage(await errorCode(enrolled)));
        return;
      }
      markDeviceInboxPasskey();
      setDone(true);
      setNotice("등록 완료. 이제 승인할 수 있습니다.");
    } catch {
      setAlert("패스키를 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="enroll" aria-labelledby="owner-inbox-enroll-title">
      <h3 id="owner-inbox-enroll-title">패스키 등록</h3>
      {done && notice.length === 0 ? <p role="status">이 기기에는 패스키가 등록되어 있습니다.</p> : null}
      {notice.length > 0 ? <p role="status">{notice}</p> : null}
      {alert.length > 0 ? <p role="alert">{alert}</p> : null}
      {done ? null : (
        <form className="enroll-form" onSubmit={(event) => { event.preventDefault(); void register(); }}>
          <label>
            일회용 등록 코드
            <input
              name="enrollment_code"
              value={code}
              autoComplete="one-time-code"
              inputMode="text"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>{busy ? "등록하는 중" : "등록하기"}</button>
        </form>
      )}
    </section>
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function bytesFrom(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function textFrom(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
