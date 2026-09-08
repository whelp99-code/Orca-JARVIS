import { DashboardApiError } from "./api.js";
import { readBoundedJson, ResponseBodyTooLargeError } from "./bounded-response.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function requestPersonalJson(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof DOMException) throw apiError("offline", "OFFLINE");
    throw error;
  }
  let body: unknown;
  try {
    body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) throw error;
    if (error instanceof SyntaxError || error instanceof ResponseBodyTooLargeError) throw apiError("server", "VALIDATION_ERROR");
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
