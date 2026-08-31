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
export async function resolveJarvisRoute(value, authorityUrl, request) {
  const parsed = parseJarvisDeepLink(value);
  if (parsed.kind === "today") return "/";
  try {
    const response = await request(`${authorityUrl}/api/v1/recommendations/${encodeURIComponent(parsed.recommendationId)}`);
    if (response.status !== 200) return "/";
    const body = await response.json();
    const current = Array.isArray(body.actions)
      && body.actions.some(action => action !== null && typeof action === "object"
        && action.rank === parsed.rank && action.current === true);
    return current ? `/recommendations/${encodeURIComponent(parsed.recommendationId)}?rank=${parsed.rank}` : "/";
  } catch (error) { if (error instanceof TypeError) return "/"; throw error; }
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
