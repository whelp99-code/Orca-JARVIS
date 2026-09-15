/** The dashboard runtime endpoint the deployed unit binds, pinned by config/dashboard-runtime.schema.json. */
export const DASHBOARD_RUNTIME_HOST = "127.0.0.1" as const;
export const DASHBOARD_RUNTIME_PORT = 4173 as const;
export const DASHBOARD_HEALTH_ROUTE = "/api/v1/health" as const;
export const DASHBOARD_HEALTH_URL =
  `http://${DASHBOARD_RUNTIME_HOST}:${DASHBOARD_RUNTIME_PORT}${DASHBOARD_HEALTH_ROUTE}` as const;
/** A health probe reads a bounded body from a loopback route; it never follows a redirect off host. */
export const DASHBOARD_HEALTH_TIMEOUT_MS = 2_000 as const;
export const DASHBOARD_HEALTH_MAX_BYTES = 65_536 as const;
