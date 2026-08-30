import { randomBytes } from "node:crypto";
import type { CapabilityProbe } from "../capabilities.js";
import type { AuthorityDb } from "../db.js";
import { PersonalCursorCodec } from "./personal-cursor.js";
import { PERSONAL_RESPONSE_MAX_BYTES } from "./personal-contracts.js";
import { contextEvidence, type PersonalLookup, recommendationDetail } from "./personal-details.js";
import { dailyRunHistory, decisionInbox, notificationIntentStates, sourceHealth } from "./personal-lists.js";
import { sanitizePersonalProjection } from "./personal-privacy.js";
import { todayProjection } from "./personal-today.js";

export type PersonalPageRequest = { readonly limit: number; readonly cursor: string | null; readonly now: Date };

export class PersonalDashboardReadModel {
  private readonly cursor = new PersonalCursorCodec(randomBytes(32));

  constructor(private readonly db: AuthorityDb, private readonly capabilityProbe: CapabilityProbe | undefined) {}

  today(now: Date): unknown {
    return bounded(todayProjection(this.db, now));
  }

  recommendation(id: string, now: Date): PersonalLookup<unknown> {
    return boundedLookup(recommendationDetail(this.db, id, now));
  }

  evidence(contextId: string, recommendationId: string, now: Date): PersonalLookup<unknown> {
    return boundedLookup(contextEvidence(this.db, contextId, recommendationId, now));
  }

  dailyRuns(request: PersonalPageRequest): unknown {
    return bounded(dailyRunHistory(this.db, { ...request, codec: this.cursor }));
  }

  decisions(request: PersonalPageRequest): unknown {
    return bounded(decisionInbox(this.db, { ...request, codec: this.cursor }));
  }

  notifications(request: PersonalPageRequest): unknown {
    return bounded(notificationIntentStates(this.db, { ...request, codec: this.cursor }));
  }

  async health(request: PersonalPageRequest): Promise<unknown> {
    return bounded(await sourceHealth(this.db, { ...request, codec: this.cursor }, this.capabilityProbe));
  }
}

function bounded(value: unknown): unknown {
  const sanitized = sanitizePersonalProjection(value);
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > PERSONAL_RESPONSE_MAX_BYTES) {
    throw new PersonalResponseTooLargeError();
  }
  return sanitized;
}

function boundedLookup(value: PersonalLookup<unknown>): PersonalLookup<unknown> {
  switch (value.kind) {
    case "not_found": return value;
    case "found": return { kind: "found", value: bounded(value.value) };
    default: return assertNever(value);
  }
}

export class PersonalResponseTooLargeError extends Error {
  readonly name = "PersonalResponseTooLargeError";
  constructor() { super("PERSONAL_RESPONSE_TOO_LARGE"); }
}

function assertNever(value: never): never {
  void value;
  throw new PersonalResponseTooLargeError();
}
