import type { Routine } from "../../../../src/routines/types.js";

export function presentRoutine(routine: Routine): { readonly id: string; readonly nextDue: number; readonly enabled: boolean } {
  return { id: routine.id, nextDue: routine.nextDue, enabled: routine.enabled };
}
