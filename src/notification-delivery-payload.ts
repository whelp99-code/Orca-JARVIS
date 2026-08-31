import { containsPrivateMetadata } from "./private-text.js";
import { NotificationDeliveryError, type MacNotificationPayload } from "./notification-delivery-types.js";

const PRIVATE_VALUE = new RegExp(
  "(?:tokens?|secrets?|passwords?|authorizations?|credentials?|passkeys?|webauthn"
  + "|public[_ -]?keys?|private[_ -]?keys?|signing[_ -]?keys?|sessions?|terminals?)",
  "iu",
);
const LINK = /^\/recommendations\/([^/?]+)\?rank=([1-9]|[12]\d|3[0-2])$/u;
type ProjectionInput = { readonly urgency: "info" | "action" | "critical"; readonly preview: string; readonly deepLink: string };
function invalid(): never { throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID"); }
function encodeLink(value: string): string {
  const match = LINK.exec(value);
  const encodedId = match?.[1]; const rank = match?.[2];
  if (encodedId === undefined || rank === undefined) return invalid();
  let id: string;
  try { id = decodeURIComponent(encodedId); } catch (error) { if (error instanceof URIError) return invalid(); throw error; }
  if (id.length === 0 || Buffer.byteLength(id, "utf8") > 256 || id !== id.normalize("NFC") || containsPrivateMetadata(id)) return invalid();
  const opaque = Buffer.from(id, "utf8").toString("base64url");
  return `jarvis://open/recommendation?id=${opaque}&rank=${rank}`;
}
export function projectMacNotificationPayload(input: ProjectionInput): MacNotificationPayload {
  if (input.preview.length === 0 || input.preview !== input.preview.normalize("NFC")
    || Buffer.byteLength(input.preview, "utf8") > 160 || containsPrivateMetadata(input.preview)
    || PRIVATE_VALUE.test(input.preview)) return invalid();
  const deepLink = encodeLink(input.deepLink);
  switch (input.urgency) {
    case "critical": return { title: "Critical decision needed", summary: input.preview,
      alert_class: "decision_critical", deep_link: deepLink };
    case "action": return { title: "Decision needed", summary: input.preview,
      alert_class: "decision_action", deep_link: deepLink };
    case "info": return { title: "Decision digest", summary: input.preview,
      alert_class: "decision_digest", deep_link: deepLink };
    default: return assertNever(input.urgency);
  }
}
function assertNever(value: never): never {
  void value;
  throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID");
}
