import { AuthorityDb, JarvisError } from "./db.js";
import type { LiveBinding, LiveObservation } from "./live-supervisor.js";
import type { OrcaRunner } from "./orca.js";
import { readBoundObservation, unknownObservation } from "./orca-bound-observation.js";
import { isTransientOrcaReadFailure } from "./orca-read-envelope.js";
import { beginObservation, finishObservation } from "./observation-health-store.js";

export async function observePersistedBinding(db: AuthorityDb, binding: LiveBinding, runner?: OrcaRunner,
  clock: () => Date = () => new Date()): Promise<readonly LiveObservation[]> {
  binding = Object.freeze({ ...binding });
  const token = beginObservation(db, binding, clock());
  if (token === null) return []; // Neither a new observation nor a new freshness timestamp.
  let values: readonly LiveObservation[];
  try { values = await readBoundObservation(binding, runner); }
  catch (error) {
    const transient = isTransientOrcaReadFailure(error);
    const code = error instanceof JarvisError && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)
      ? error.code : "ORCA_OBSERVATION_FAILED";
    finishObservation(db, binding, token, clock(), transient ? "unavailable" : "fatal", code);
    if (!transient) throw new JarvisError(code);
    return [{ ...unknownObservation(binding), observation_attempt_id: token }];
  }
  const known = values.length === 1 && typeof values[0]?.connected === "boolean";
  finishObservation(db, binding, token, clock(), known ? "healthy" : "unknown", known ? null : "ORCA_BINDING_NOT_OBSERVED");
  return values.map(value => ({ ...value, observation_attempt_id: token }));
}
