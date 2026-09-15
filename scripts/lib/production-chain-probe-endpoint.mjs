// Where the packaged production chain probe gets its provider and its injected instants from.
//
// The probe defaults to the development-checkout fixture child and the shipped frozen instant, so
// an ordinary run is unchanged. Two deployment shapes need more than that:
//
//   JARVIS_SECOND_BRAIN_LAUNCHER + JARVIS_SECOND_BRAIN_CONFIG
//     Both set: every provider-using arm talks to that installed provider instead of the fixture
//     child. Either one alone is ignored, because half an endpoint is not an endpoint.
//   PROBE_AT / PROBE_MEMORY_AT
//     A real provider answers on the real wall clock and refuses a read fence minted far from it,
//     so the injected morning instant has to be movable. PROBE_AT moves it, and every other
//     harness-supplied instant shifts by the same delta, keeping the relative positions the probe
//     shipped with. PROBE_MEMORY_AT overrides the memory instant alone.
//
// The providerless arm must stay providerless even when the two launcher variables are exported
// into the shell, which is what providerlessEnvironment() is for.

/** The instants the probe shipped with. Every other instant it injects is relative to these. */
export const SHIPPED_PROBE_AT = "2026-08-28T22:15:00.000Z";
export const SHIPPED_PROBE_MEMORY_AT = "2026-08-28T12:00:00.000Z";
const CLI_OFFSET_MS = 5;

const instant = value => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`PROBE_INSTANT_INVALID: ${value}`);
  }
  return ms;
};

/**
 * The provider endpoint this run reads through. `kind` is recorded in the receipt so a reader can
 * tell an installed-release run from a fixture-child run without reconstructing the environment.
 */
export function probeProviderEndpoint(environment = process.env) {
  const launcher = environment.JARVIS_SECOND_BRAIN_LAUNCHER;
  const config = environment.JARVIS_SECOND_BRAIN_CONFIG;
  if (typeof launcher === "string" && launcher.length > 0 && typeof config === "string" && config.length > 0) {
    return { kind: "installed_release", launcher, config };
  }
  return { kind: "development_checkout_fixture_child" };
}

/**
 * Every instant the harness injects, moved together. `shifted` maps any instant expressed against
 * the shipped frozen clock onto this run's clock; `shift` offsets from the morning instant.
 */
export function probeInstants(environment = process.env) {
  const at = environment.PROBE_AT ?? SHIPPED_PROBE_AT;
  const delta = instant(at) - instant(SHIPPED_PROBE_AT);
  const shifted = value => new Date(instant(value) + delta).toISOString();
  return {
    AT: at,
    CLI_AT: new Date(instant(at) + CLI_OFFSET_MS).toISOString(),
    MEMORY_AT: environment.PROBE_MEMORY_AT ?? shifted(SHIPPED_PROBE_MEMORY_AT),
    shift_ms: delta,
    shifted,
    shift: ms => new Date(instant(at) + ms).toISOString(),
  };
}

/** A copy of `environment` that names no provider, whatever the caller's shell exported. */
export function providerlessEnvironment(environment = process.env) {
  const copy = { ...environment };
  delete copy.JARVIS_SECOND_BRAIN_LAUNCHER;
  delete copy.JARVIS_SECOND_BRAIN_CONFIG;
  return copy;
}
