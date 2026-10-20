export function resolveE2ePort(env, defaultPort) {
  const value = env.JARVIS_E2E_PORT ?? env.JARVIS_E2E_SEEDED_PORT_1440 ?? String(defaultPort);
  const port = Number(value);
  if (value === "" || /\D/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("JARVIS_E2E_PORT_INVALID");
  }
  return port;
}
