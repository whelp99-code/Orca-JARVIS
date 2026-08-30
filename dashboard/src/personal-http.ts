import { DashboardApiError } from "./api.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function requestPersonalJson(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof DOMException) throw apiError("offline", "OFFLINE");
    throw error;
  }
  let body: unknown;
  try {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
      throw apiError("server", "VALIDATION_ERROR");
    }
    body = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) throw error;
    if (error instanceof SyntaxError) throw apiError("server", "VALIDATION_ERROR");
    throw error;
  }
  if (!response.ok) {
    const kind = response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "server";
    throw apiError(kind, "REQUEST_FAILED");
  }
  return body;
}

function apiError(
  kind: "offline" | "forbidden" | "not_found" | "server",
  code: string,
): DashboardApiError {
  return new DashboardApiError({
    kind,
    code,
    message: kind === "offline" ? "Dashboard unavailable" : "Validation error",
    request_id: "",
  });
}
