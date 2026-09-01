export type CycleApplyResult =
  | { readonly kind: "applied"; readonly id: number }
  | { readonly kind: "duplicate"; readonly id: number }
  | { readonly kind: "rejected"; readonly id: number; readonly last_completed: number };

export function applyCycleId(lastCompleted: number, id: number): CycleApplyResult {
  if (id <= lastCompleted) return { kind: "duplicate", id };
  if (id === lastCompleted + 1) return { kind: "applied", id };
  return { kind: "rejected", id, last_completed: lastCompleted };
}
