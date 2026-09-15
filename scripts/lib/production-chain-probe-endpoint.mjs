// Where the packaged production chain probe gets its provider and its injected instants from.
//
// The probe defaults to the development-checkout fixture child and the shipped frozen instant, so
// an ordinary run is unchanged. Two deployment shapes need more than that:
//
//   JARVIS_SECOND_BRAIN_LAUNCHER + JARVIS_SECOND_BRAIN_CONFIG
//     Both set: every provider-using arm talks to that installed provider instead of the fixture
//     child. Either one alone is ignored, because half an endpoint is not an endpoint.
//   PROBE_PAGE / PROBE_SID
//     The page and section the run's own settled write landed on. The probe stages that write
//     itself, so with the fixture child it picks the destination; against an installed provider the
//     destination has to be one that provider actually serves, or the reference seam correctly
//     refuses to rest on the record (no settled write of ours on that page and section).
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

export const SHIPPED_PROBE_PAGE = "wiki/example-alpha";
export const SHIPPED_PROBE_SID = "12345678";

/**
 * The destination the probe's own settled write is recorded against, and the one the provider must
 * serve a record on for the reference seam to admit it.
 */
export function probeArtifactDestination(environment = process.env) {
  const page = environment.PROBE_PAGE ?? SHIPPED_PROBE_PAGE;
  const sid = environment.PROBE_SID ?? SHIPPED_PROBE_SID;
  if (typeof page !== "string" || !/^[a-z0-9][a-z0-9/_-]{0,127}$/.test(page)) {
    throw new Error(`PROBE_PAGE_INVALID: ${page}`);
  }
  if (typeof sid !== "string" || !/^[0-9a-f]{8}$/.test(sid)) throw new Error(`PROBE_SID_INVALID: ${sid}`);
  return { page_id: page, sid };
}

/** A copy of `environment` that names no provider, whatever the caller's shell exported. */
export function providerlessEnvironment(environment = process.env) {
  const copy = { ...environment };
  delete copy.JARVIS_SECOND_BRAIN_LAUNCHER;
  delete copy.JARVIS_SECOND_BRAIN_CONFIG;
  return copy;
}
