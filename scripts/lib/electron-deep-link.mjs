const MAX_URL_BYTES = 512;
const MAX_ID_BYTES = 256;
const PRIVATE = /(?:password|token|secret|authorization|credential|private[_-]?key)\s*[:=]|\/(?:home|Users|root)\//iu;

export class ElectronDeepLinkError extends Error {
  constructor(code) { super(code); this.name = "ElectronDeepLinkError"; this.code = code; }
}
function invalid() { throw new ElectronDeepLinkError("ELECTRON_DEEP_LINK_INVALID"); }
function safeId(value) {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
    && value === value.normalize("NFC") && !PRIVATE.test(value)
    && ![...value].some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
}
export function encodeRecommendationDeepLink(recommendationId, rank) {
  if (!safeId(recommendationId) || !Number.isInteger(rank) || rank < 1 || rank > 32) return invalid();
  return `jarvis://open/recommendation?id=${Buffer.from(recommendationId, "utf8").toString("base64url")}&rank=${rank}`;
}
function exact(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) return invalid();
  return value;
}
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function text(value, limit = 512) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > limit) return invalid();
  return value;
}
function time(value) { if (typeof value !== "string" || !TIME.test(value) || !Number.isFinite(Date.parse(value))) return invalid(); }
function digest(value) { if (typeof value !== "string" || !DIGEST.test(value)) return invalid(); }
function currentAction(value, rank) {
  if (!Array.isArray(value) || value.length > 32) return invalid();
  return value.some(item => {
    const action = exact(item, ["rank", "title", "operation", "target_digest", "state", "owner_decision_required",
      "current", "occurred_at", "transition_digest"]);
    if (!Number.isInteger(action.rank) || action.rank < 1 || action.rank > 32
      || !["pending", "accepted", "rejected", "expired", "superseded", "dismissed", "snoozed"].includes(action.state)
      || typeof action.owner_decision_required !== "boolean" || typeof action.current !== "boolean"
      || (action.occurred_at !== null && (typeof action.occurred_at !== "string" || !TIME.test(action.occurred_at)))
      || (action.transition_digest !== null && typeof action.transition_digest !== "string")) return invalid();
    digest(action.target_digest); if (action.transition_digest !== null) digest(action.transition_digest);
    text(action.title); text(action.operation, 128);
    return action.rank === rank && action.state === "pending" && action.current === true;
  });
}
function validateDetails(body, recommendationId) {
  if (body.schema_version !== 1 || body.resource !== "recommendation" || body.recommendation_id !== recommendationId
    || !["none", "owner"].includes(body.approval_requirement) || !["low", "medium", "high"].includes(body.confidence_class)
    || !["drafted", "parsed", "eligible", "abstained", "presented", "selected", "rejected", "expired"].includes(body.lifecycle_state)
    || !["ready", "degraded", "no_data", "offline", "stale"].includes(body.state)) return invalid();
  text(body.context_id, 256); digest(body.canonical_digest); digest(body.evidence_digest); time(body.expires_at);
  for (const key of ["evidence", "conflicts", "omissions"]) if (!Array.isArray(body[key]) || body[key].length > 32) return invalid();
  if (body.conflicts.some(item => typeof item !== "string") || body.omissions.some(item => typeof item !== "string")) return invalid();
  for (const item of body.evidence) {
    const row = exact(item, ["evidence_id", "source_id", "kind", "digest", "observed_at", "fresh_until"]);
    text(row.evidence_id, 256); text(row.source_id, 256); text(row.kind, 128);
    digest(row.digest); time(row.observed_at); if (row.fresh_until !== null) time(row.fresh_until);
  }
  const links = exact(body.deep_links, ["context_evidence"]); text(links.context_evidence, 2048);
}
export async function resolveJarvisRoute(value, authorityUrl, request) {
  const parsed = parseJarvisDeepLink(value);
  if (parsed.kind === "today") return "/";
  try {
    const response = await request(`${authorityUrl}/api/v1/recommendations/${encodeURIComponent(parsed.recommendationId)}`);
    if (response.status !== 200) return "/";
    if (!/^application\/json(?:; charset=utf-8)?$/iu.test(response.headers.get("content-type") ?? "")) return invalid();
    const body = exact(await response.json(), ["schema_version", "resource", "recommendation_id", "context_id",
      "canonical_digest", "evidence_digest", "approval_requirement", "confidence_class", "lifecycle_state", "expires_at",
      "state", "actions", "evidence", "conflicts", "omissions", "deep_links"]);
    validateDetails(body, parsed.recommendationId);
    return currentAction(body.actions, parsed.rank)
      ? `/recommendations/${encodeURIComponent(parsed.recommendationId)}?rank=${parsed.rank}` : "/";
  } catch (error) {
    if (error instanceof TypeError || error instanceof ElectronDeepLinkError) return "/";
    throw error;
  }
}
export function createDeepLinkCoordinator({ authorityUrl, request, focus, navigate, onError }) {
  return { open: async value => {
    let parsed;
    try { parsed = parseJarvisDeepLink(value); }
    catch (error) {
      if (error instanceof ElectronDeepLinkError) { onError(error.code); return; }
      throw error;
    }
    const route = await resolveJarvisRoute(value, authorityUrl, request);
    if (parsed.kind === "recommendation" && route === "/") onError("ELECTRON_RESOURCE_UNAVAILABLE");
    focus(); await navigate(route);
  } };
}
export function parseJarvisDeepLink(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) return invalid();
  let url;
  try { url = new URL(value); } catch (error) { if (error instanceof TypeError) return invalid(); throw error; }
  if (url.protocol !== "jarvis:" || url.hostname !== "open" || url.username || url.password || url.port || url.hash) return invalid();
  if (url.pathname === "/today") {
    if ([...url.searchParams.keys()].length !== 0) return invalid();
    return { kind: "today" };
  }
  if (url.pathname !== "/recommendation" || [...url.searchParams.keys()].sort().join(",") !== "id,rank"
    || url.searchParams.getAll("id").length !== 1 || url.searchParams.getAll("rank").length !== 1) return invalid();
  const encoded = url.searchParams.get("id"); const rankText = url.searchParams.get("rank");
  if (encoded === null || rankText === null || encoded.length === 0 || encoded.length > 342
    || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^(?:[1-9]|[12]\d|3[0-2])$/u.test(rankText)) return invalid();
  const recommendationId = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(recommendationId, "utf8").toString("base64url") !== encoded || !safeId(recommendationId)) return invalid();
  return { kind: "recommendation", recommendationId, rank: Number(rankText) };
}
