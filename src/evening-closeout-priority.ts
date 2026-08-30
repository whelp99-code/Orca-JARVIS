import type { CloseoutPriority, CloseoutTomorrowAction } from "./evening-closeout-types.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";

const ordinal = (left: string, right: string, order: readonly string[]): number =>
  order.indexOf(left) - order.indexOf(right);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export function compareCloseoutPriority(left: CloseoutPriority, right: CloseoutPriority): number {
  const comparisons = [
    ordinal(
      left.owner_safety_gate,
      right.owner_safety_gate,
      PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate,
    ),
    ordinal(left.customer_impact, right.customer_impact, PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    ordinal(left.deadline_bucket, right.deadline_bucket, PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    ordinal(
      left.dependency_blocking,
      right.dependency_blocking,
      PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking,
    ),
    ordinal(left.irreversible_risk, right.irreversible_risk, PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    ordinal(left.effort_cost, right.effort_cost, PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
  ];
  return comparisons.find(value => value !== 0) ?? compareText(left.stable_identity, right.stable_identity);
}
export function compareCloseoutAction(left: CloseoutTomorrowAction, right: CloseoutTomorrowAction): number {
  return compareCloseoutPriority(left.priority, right.priority) || compareText(left.action_id, right.action_id);
}
