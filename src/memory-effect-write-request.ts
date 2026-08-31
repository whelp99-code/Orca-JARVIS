import type { MemoryEffectValidationOptions } from "./second-brain-effect-v2.js";
import {
  parseMemoryEffectWriteRequest,
  snapshotMemoryEffectWriteArguments,
} from "./second-brain-effect-v2.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";
import {
  MemoryEffectWriteRequestV2Schema,
  MemoryWriteRequestSchema,
  MemoryWriteRequestV1Schema,
} from "./memory-effect-write-zod.js";
import type {
  MemoryEffectWriteRequest,
  MemoryWriteRequest,
  MemoryWriteRequestV1,
} from "./memory-effect-write-types.js";

export function parseMemoryWriteRequestV1(
  value: unknown,
  now: Date,
): MemoryWriteRequestV1 | undefined {
  const shape = MemoryWriteRequestV1Schema.safeParse(value);
  if (!shape.success) return undefined;
  return parseSecondBrainWriteRequest(shape.data, now);
}

export function parseMemoryEffectRequest(
  value: unknown,
  options: MemoryEffectValidationOptions,
): MemoryEffectWriteRequest | undefined {
  const shape = MemoryEffectWriteRequestV2Schema.safeParse(value);
  if (!shape.success) return undefined;
  return parseMemoryEffectWriteRequest(shape.data, options);
}

export function parseMemoryWriteRequest(
  value: unknown,
  now: Date,
  options: MemoryEffectValidationOptions,
): MemoryWriteRequest | undefined {
  const shape = MemoryWriteRequestSchema.safeParse(value);
  if (!shape.success) return undefined;
  if (shape.data.schema_version === 1) return parseMemoryWriteRequestV1(shape.data, now);
  return parseMemoryEffectRequest(shape.data, options);
}

export function snapshotMemoryWriteArguments(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const input = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (input === undefined || Object.keys(input).sort().join("\0") !== "request") return undefined;
  const request = input.request;
  const schema = request !== null && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>).schema_version
    : undefined;
  if (schema === 2) return snapshotMemoryEffectWriteArguments(value);
  const createdAt = request !== null && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>).created_at
    : undefined;
  if (typeof createdAt !== "string") return undefined;
  const parsed = parseMemoryWriteRequestV1(request, new Date(createdAt));
  return parsed === undefined ? undefined : Object.freeze({ request: parsed });
}
