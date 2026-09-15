import { attestedSecondBrainHandshake, type SecondBrainHandshakeFacts } from "./second-brain-readiness-handshake.js";
import type { SecondBrainDataState, SecondBrainProbeFailure } from "./second-brain-readiness.js";
import { SecondBrainTransportError, createSecondBrainTransport } from "./second-brain-transport.js";

/**
 * What one bounded read through the negotiated transport establishes.
 *
 * The provider answers `sb_generation_status` with the contract digest it implements, the health of
 * the generation it would serve, and -- by answering at all -- the fact that this deployment's
 * identity is authorized to read. Readiness used to assert none of this: it hardcoded
 * `read_authorization: "unauthorized"` and `contract_digest: null`, so the authorized and
 * protocol_compatible stages could never be decided from a live provider. Nothing here is a write:
 * `sb_generation_status` is a read method and the transport refuses any other.
 */
export type SecondBrainReadFacts = {
  readonly read: "authorized" | "unauthorized";
  readonly contract_digest: string | null;
  readonly data_state: SecondBrainDataState;
};

export const UNREAD_SECOND_BRAIN_FACTS: SecondBrainReadFacts = {
  read: "unauthorized", contract_digest: null, data_state: "unknown",
};

export type SecondBrainHandshakeResult =
  | { readonly kind: "ok"; readonly stdout: string; readonly facts?: SecondBrainHandshakeFacts;
      readonly read?: SecondBrainReadFacts }
  | { readonly kind: SecondBrainProbeFailure };

/**
 * Starts the provider once, attests the handshake it negotiated, and reads through it.
 *
 * One child process serves both: a readiness probe that spawned the provider twice would double
 * the cost of every dashboard health poll.
 */
export async function attestedSecondBrainHandshakeRead(endpoint: {
  readonly launcher: string;
  readonly config: string;
}): Promise<SecondBrainHandshakeResult> {
  const transport = createSecondBrainTransport({
    launcherPath: endpoint.launcher, configPath: endpoint.config, safeReadRetries: 0,
  });
  let result: SecondBrainHandshakeResult;
  try {
    await transport.restart();
    const facts = attestedSecondBrainHandshake(transport.diagnostics());
    result = facts === undefined
      ? { kind: "malformed" }
      : { kind: "ok", stdout: "", facts, read: await readFacts(transport) };
  } catch (error) {
    if (!(error instanceof SecondBrainTransportError)) throw error;
    result = { kind: transportFailure(error) };
  }
  try {
    await transport.close();
  } catch (error) {
    if (!(error instanceof SecondBrainTransportError)) throw error;
    return { kind: "unavailable" };
  }
  return result;
}

async function readFacts(
  transport: ReturnType<typeof createSecondBrainTransport>,
): Promise<SecondBrainReadFacts> {
  let outcome: Awaited<ReturnType<typeof transport.call>>;
  try {
    outcome = await transport.call("sb_generation_status", { read_fence: null });
  } catch (error) {
    if (!(error instanceof SecondBrainTransportError)) throw error;
    return UNREAD_SECOND_BRAIN_FACTS;
  }
  // A refusal is a refusal: no error code is read back as a grant, and no provider text is kept.
  if (outcome.kind !== "data") return UNREAD_SECOND_BRAIN_FACTS;
  const digest = outcome.value["contract_digest"];
  return {
    read: "authorized",
    contract_digest: typeof digest === "string" && digest !== "" ? digest : null,
    data_state: generationState(outcome.value),
  };
}

/**
 * The vault state a granted generation read establishes.
 *
 * `sb_generation_status` reports pointer and journal health for the generation it would serve. A
 * healthy pair is a servable vault; an unhealthy one is a provider that answered but cannot serve;
 * anything else stays unknown rather than being guessed into `ready`.
 */
function generationState(value: Readonly<Record<string, unknown>>): SecondBrainDataState {
  const pointer = value["pointer_health"];
  const journal = value["journal_health"];
  if (pointer === "healthy" && journal === "healthy") return "ready";
  if (typeof pointer !== "string" || typeof journal !== "string") return "unknown";
  return "unavailable";
}

export function transportFailure(error: SecondBrainTransportError): SecondBrainProbeFailure {
  if (error.code === "SECOND_BRAIN_STARTUP_TIMEOUT") return "timeout";
  if (error.code === "SECOND_BRAIN_OVERSIZE_FRAME") return "oversize";
  if (error.code === "SECOND_BRAIN_CHILD_EXIT") return "crash";
  return "malformed";
}
