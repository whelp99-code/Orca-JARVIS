export type PersonalSseType = "snapshot" | "reconcile";
export type PersonalSseRevision = Readonly<{ incarnation: string; sequence: number }>;
export type PersonalSseFrame = Readonly<{
  type: PersonalSseType;
  revision: PersonalSseRevision;
  topics: readonly string[];
  occurredAt: string;
}>;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9]\d*)$/u;
const TOPICS = new Set([
  "overview", "tasks", "agents", "approvals",
  "personal.today.v1", "personal.recommendations.v1", "personal.context-evidence.v1",
  "personal.daily-runs.v1", "personal.decision-inbox.v1", "personal.notification-intents.v1",
  "personal.source-health.v1", "memory.records.v1", "memory.conflicts.v1",
  "memory.candidates.v1", "memory.effects.v1", "memory.privacy.v1", "memory.status.v1",
]);

export function parsePersonalSseFrame(eventType: PersonalSseType, event: Event): PersonalSseFrame | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string" || event.data.length > 16_384) return undefined;
  let value: unknown;
  try { value = JSON.parse(event.data); }
  catch (error: unknown) { if (error instanceof SyntaxError) return undefined; throw error; }
  const row = closedRecord(value, ["schema_version", "type", "revision", "topics", "occurred_at"]);
  if (row === undefined || row["schema_version"] !== 1 || row["type"] !== eventType) return undefined;
  const revision = parseRevision(row["revision"]);
  const topics = closedTopics(row["topics"]);
  const occurredAt = row["occurred_at"];
  if (revision === undefined || topics === undefined || typeof occurredAt !== "string"
    || !TIME.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) return undefined;
  return { type: eventType, revision, topics, occurredAt };
}

export function advancesPersonalRevision(
  previous: PersonalSseRevision | undefined,
  frame: PersonalSseFrame,
): boolean {
  if (previous === undefined) return frame.type === "snapshot";
  if (previous.incarnation === frame.revision.incarnation) return frame.revision.sequence > previous.sequence;
  return frame.type === "snapshot";
}

function parseRevision(value: unknown): PersonalSseRevision | undefined {
  if (typeof value !== "string") return undefined;
  const match = REVISION.exec(value);
  if (match === null) return undefined;
  const incarnation = match[1]; const rawSequence = match[2];
  if (incarnation === undefined || rawSequence === undefined) return undefined;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? { incarnation, sequence } : undefined;
}

function closedTopics(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return undefined;
  const topics: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
      || !descriptor.enumerable || typeof descriptor.value !== "string") return undefined;
    const topic = descriptor.value;
    if (!(TOPICS.has(topic) || /^task:[A-Za-z0-9_.:-]{1,128}$/u.test(topic)) || topics.includes(topic)) return undefined;
    topics.push(topic);
  }
  return topics;
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}
