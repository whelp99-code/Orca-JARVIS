import { createOrcaReadRunner } from "../../orca-read-runner.js";
import { parseOrcaReadPayload } from "../../orca-read-envelope.js";
import type { Source, WorkEvent } from "../contracts.js";

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A terminal handle is an observable shell session, not proof of an agent task. */
export function terminalEvents(output: string, source: Source, observedAt: string): WorkEvent[] {
  const result = parseOrcaReadPayload(output);
  if (!Array.isArray(result.terminals)) throw new Error("WORKBOARD_TERMINAL_INVALID");
  return result.terminals.map((item): WorkEvent => {
    if (!object(item) || typeof item.handle !== "string" || !item.handle ||
      typeof item.incarnationId !== "string" || !item.incarnationId) throw new Error("WORKBOARD_TERMINAL_INVALID");
    return { source, sessionId: item.handle, incarnation: item.incarnationId,
      eventId: `terminal:${item.handle}:${item.incarnationId}:${observedAt}`, sequence: Date.parse(observedAt),
      taskId: null, receivedAt: observedAt, sourceAt: observedAt, state: "unknown",
      summary: "Unclassified terminal session", evidenceRef: `orca-terminal://${item.handle}` };
  });
}
export async function collectOrcaTerminals(source: Source, observedAt: string,
  run: (args: readonly string[]) => Promise<string> = createOrcaReadRunner()): Promise<WorkEvent[]> {
  const args = ["terminal", "list", ...(source.host === "mac" ? ["--environment", "MAC"] : []), "--json"];
  return terminalEvents(await run(args), source, observedAt);
}
