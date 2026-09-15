import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { jsonFile, objectValue } from "./cli-command-input.js";
import { JarvisError } from "./db.js";
import { assembleDispatchContext, parseDispatchEnvelope, preflightDispatchAssemble } from "./cli-gjc-dispatch-assemble.js";

/** The explicit gjc.dispatch subcommand: reserve, recover an uncertain send, then assemble and send. */
export async function runGjcDispatch(context: CliCommandContext, argument: string): Promise<Record<string, unknown>> {
  const { db } = context;
    const envelope = objectValue(await jsonFile(argument));
    const parsed = parseDispatchEnvelope(envelope);
    const now = commandNow(context).toISOString();
    db.assertGjcDispatchTask(parsed.task, now);
    preflightDispatchAssemble(context, parsed);
    const reservation = db.reserveGjcDispatchFromTask(parsed.task, now);
    if (!reservation.reserved) {
      const latestAttempt = db.latestGjcSendAttempt(reservation.intent_id, reservation.lease_fence);
      const unknownSend = (latestAttempt !== undefined && !latestAttempt.failed)
        || (latestAttempt === undefined && db.gjcIntentHasEvent(reservation.intent_id, "model_send_started"));
      if (unknownSend && !db.gjcIntentHasEvent(reservation.intent_id, "model_dispatched")) {
        const deliveryId = db.gjcSendDeliveryId(reservation.intent_id);
        const transport = context.dependencies.memoryReferenceOptions?.model_transport;
        const reconciled = deliveryId !== undefined && transport !== undefined && "reconcile" in transport
          ? await (transport as { reconcile?: (id: string) => Promise<{ accepted: boolean } | undefined> }).reconcile?.(deliveryId)
          : undefined;
        if (reconciled?.accepted === true) {
          db.recordGjcReconciledReceipt(reservation.intent_id, now);
          return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, recovered: "remote_accepted" };
        }
        return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, recovered: "unknown_accepted" };
      }
      return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, duplicate: true };
    }
    try {
      const assembled = await assembleDispatchContext(context, parsed, reservation);
      if (assembled !== undefined) db.recordGjcModelDispatched(reservation.intent_id, now, reservation.lease_fence);
      return {
        ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id,
        ...(assembled === undefined ? {} : { model_request_bytes: assembled.capture.bytes, model_session_id: assembled.capture.session_id }),
      };
    } catch (error) {
      if (error instanceof JarvisError && error.code === "MODEL_TRANSPORT_UNAVAILABLE") {
        db.recordGjcSendFailed(reservation.intent_id, now, reservation.lease_fence);
      }
      db.markGjcIntentUncertain(reservation.intent_id, now);
      throw error;
    }
}
