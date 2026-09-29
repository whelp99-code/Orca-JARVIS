/** CORE5_INTEGRATION_ENABLED defaults off. Only "1" or "true" (case-insensitive) enable. */
export function isCore5IntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CORE5_INTEGRATION_ENABLED;
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}
