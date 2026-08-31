import { canonicalize } from "./canonical.js";
import { sanitizePersonalProjection } from "./dashboard/personal-privacy.js";
import { containsPrivateMetadata } from "./private-text.js";
import { NotificationDeliveryError, type MacNotificationPayload } from "./notification-delivery-types.js";

const PRIVATE_VALUE = new RegExp(
  "(?:tokens?|secrets?|passwords?|authorizations?|credentials?|passkeys?|webauthn"
  + "|public[_ -]?keys?|private[_ -]?keys?|signing[_ -]?keys?|sessions?|terminals?)",
  "iu",
);
const PRIVACY_CANARY = /TASK33_(?:TOKEN|PRIVATE_NAME|COMMAND|EXCERPT|BEARER)_CANARY/iu;
const LINK = /^\/recommendations\/([^/?]+)\?rank=([1-9]|[12]\d|3[0-2])$/u;
type ProjectionInput = { readonly urgency: "info" | "action" | "critical"; readonly preview: string; readonly deepLink: string };
function invalid(): never { throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID"); }
function safeText(value: string): boolean {
  return value === value.normalize("NFC") && !containsPrivateMetadata(value) && !PRIVATE_VALUE.test(value)
    && !PRIVACY_CANARY.test(value);
}
function safeEnvelope(value: Readonly<Record<string, unknown>>): boolean {
  const canonical = canonicalize(value);
  return safeText(canonical) && canonicalize(sanitizePersonalProjection(value)) === canonical;
}
function encodeLink(value: string): string {
  const match = LINK.exec(value);
  const encodedId = match?.[1]; const rank = match?.[2];
  if (encodedId === undefined || rank === undefined) return invalid();
  let id: string;
  try { id = decodeURIComponent(encodedId); } catch (error) { if (error instanceof URIError) return invalid(); throw error; }
  if (id.length === 0 || Buffer.byteLength(id, "utf8") > 256 || !safeText(id) || !safeText(value)) return invalid();
  const opaque = Buffer.from(id, "utf8").toString("base64url");
  return `jarvis://open/recommendation?id=${opaque}&rank=${rank}`;
}
export function projectMacNotificationPayload(input: ProjectionInput): MacNotificationPayload {
  if (input.preview.length === 0 || Buffer.byteLength(input.preview, "utf8") > 160
    || !safeText(input.preview) || !safeEnvelope(input)) return invalid();
  const deepLink = encodeLink(input.deepLink);
  let payload: MacNotificationPayload;
  switch (input.urgency) {
    case "critical": payload = { title: "Critical decision needed", summary: input.preview,
      alert_class: "decision_critical", deep_link: deepLink }; break;
    case "action": payload = { title: "Decision needed", summary: input.preview,
      alert_class: "decision_action", deep_link: deepLink }; break;
    case "info": payload = { title: "Decision digest", summary: input.preview,
      alert_class: "decision_digest", deep_link: deepLink }; break;
    default: return assertNever(input.urgency);
  }
  if (!Object.values(payload).every(safeText) || !safeEnvelope(payload)) return invalid();
  return payload;
}
function assertNever(value: never): never {
  void value;
  throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID");
}
