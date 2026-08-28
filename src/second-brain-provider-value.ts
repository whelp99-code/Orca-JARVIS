import { types as utilTypes } from "node:util";
import {
  SECOND_BRAIN_PROVIDER_MAX_DEPTH,
  SECOND_BRAIN_PROVIDER_MAX_NODES,
  SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS,
} from "./second-brain-read-budget.js";

type ProviderValue = null | boolean | number | string | ProviderValue[] | { [key: string]: ProviderValue };
type CloneResult =
  | { readonly ok: true; readonly value: ProviderValue }
  | { readonly ok: false };
type CloneState = {
  nodes: number;
  workItems: number;
  readonly active: WeakSet<object>;
};

const INVALID: CloneResult = { ok: false };

function cloneProviderValue(value: unknown, depth: number, state: CloneState): CloneResult {
  state.nodes += 1;
  state.workItems += 1;
  if (depth > SECOND_BRAIN_PROVIDER_MAX_DEPTH || state.nodes > SECOND_BRAIN_PROVIDER_MAX_NODES
    || state.workItems > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return INVALID;
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : INVALID;
  if (typeof value !== "object" || utilTypes.isProxy(value) || state.active.has(value)) return INVALID;
  state.active.add(value);
  const result = Array.isArray(value)
    ? cloneProviderArray(value, depth, state)
    : cloneProviderRecord(value, depth, state);
  state.active.delete(value);
  return result;
}

function cloneProviderArray(value: unknown[], depth: number, state: CloneState): CloneResult {
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > SECOND_BRAIN_PROVIDER_MAX_NODES) return INVALID;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return INVALID;
  const cloned: ProviderValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return INVALID;
    const item = cloneProviderValue(descriptor.value, depth + 1, state);
    if (!item.ok) return INVALID;
    cloned.push(item.value);
  }
  return { ok: true, value: cloned };
}

function cloneProviderRecord(value: object, depth: number, state: CloneState): CloneResult {
  if (Object.getPrototypeOf(value) !== Object.prototype) return INVALID;
  const keys = Reflect.ownKeys(value);
  if (keys.length > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return INVALID;
  const cloned: { [key: string]: ProviderValue } = {};
  for (const key of keys) {
    state.workItems += 1;
    if (typeof key !== "string" || state.workItems > SECOND_BRAIN_PROVIDER_MAX_WORK_ITEMS) return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return INVALID;
    const item = cloneProviderValue(descriptor.value, depth + 1, state);
    if (!item.ok) return INVALID;
    cloned[key] = item.value;
  }
  return { ok: true, value: cloned };
}

export function normalizeSecondBrainProviderRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const result = cloneProviderValue(value, 0, { nodes: 0, workItems: 0, active: new WeakSet() });
    return result.ok && !Array.isArray(result.value) && result.value !== null && typeof result.value === "object"
      ? result.value
      : undefined;
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}
