import { createContext, useContext } from "react";
import { gatewayOrigin } from "./webauthn-ceremony.js";

/**
 * Where the document was served from. `local` is the loopback control center with
 * the authority stream and owner mutations; `phone` is the tailnet gateway, which
 * serves the same build read-only behind its own session and CSRF boundary.
 */
export type DashboardSurface = "local" | "phone";

export const SurfaceContext = createContext<DashboardSurface>("local");

export function useSurface(): DashboardSurface {
  return useContext(SurfaceContext);
}

export function detectSurface(): DashboardSurface {
  return gatewayOrigin() ? "phone" : "local";
}
