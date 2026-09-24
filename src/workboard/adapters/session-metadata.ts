import { validateEvent, type Source, type SessionRelation, type WorkEvent } from "../contracts.js";

/** Codex, Claude, OmO/Senpi and business connectors supply bounded metadata only.
 * A historical file finder entry is not a currently observable task. */
export type SessionMetadata = {
  sessionId: string; incarnation: string; eventId: string; sequence: number;
  observedAt: string; sourceAt: string; taskId?: string; parent?: SessionRelation; alias?: SessionRelation;
  summary: string; evidenceRef: string; state: WorkEvent["state"];
};
export function metadataEvent(source: Source, metadata: SessionMetadata): WorkEvent {
  const event: WorkEvent = { source, sessionId: metadata.sessionId.replace(/\.history$/u, ""),
    incarnation: metadata.incarnation, eventId: metadata.eventId, sequence: metadata.sequence,
    taskId: metadata.taskId ?? null, parent: metadata.parent, alias: metadata.alias,
    summary: metadata.summary, evidenceRef: metadata.evidenceRef, state: metadata.state,
    sourceAt: metadata.sourceAt, receivedAt: metadata.observedAt };
  validateEvent(event);
  return event;
}
