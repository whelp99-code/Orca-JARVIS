import {
  SecondBrainProviderClient,
  type ProviderHealth,
  type ProviderTransportOptions,
} from "./second-brain-provider.js";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  type SecondBrainReadinessObservation,
  type SecondBrainReadinessProbe,
} from "./second-brain-readiness.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "./second-brain-transport.js";

export type ProviderReadinessClient = Readonly<{
  health(): Promise<ProviderHealth>;
  close(): Promise<void>;
}>;

export type ProviderReadinessOptions = Readonly<{
  provider?: ProviderTransportOptions;
  open?: () => ProviderReadinessClient;
}>;

function unavailable(): SecondBrainReadinessObservation {
  return {
    executable: "unavailable",
    configuration: "unavailable",
    contract_digest: null,
    protocol_version: null,
    tools: null,
    schemas_compatible: false,
    input_schemas_compatible: false,
    output_schemas_compatible: false,
    status: "unavailable",
    doctor: "unavailable",
    handshake: "unavailable",
    status_operational: false,
    doctor_operational: false,
    channels_consistent: false,
    read_authorization: "unauthorized",
    write_authorization: "unauthorized",
    authorization_consistent: true,
    data_state: "unavailable",
    refresh: { kind: "missing" },
  };
}

function observation(health: ProviderHealth): SecondBrainReadinessObservation {
  const compatible = health.kind === "health"
    && health.status === "ok"
    && health.contract === "second-brain-provider-v1"
    && health.version === "1";
  const writable = compatible && health.writable;
  return {
    executable: "available",
    configuration: compatible ? "valid" : "malformed",
    contract_digest: compatible ? SECOND_BRAIN_FROZEN_DIGEST : null,
    protocol_version: compatible ? SECOND_BRAIN_PROTOCOL_VERSION : null,
    tools: compatible ? SECOND_BRAIN_REQUIRED_TOOLS : null,
    schemas_compatible: compatible,
    input_schemas_compatible: compatible,
    output_schemas_compatible: compatible,
    status: compatible ? "ok" : "malformed",
    doctor: compatible ? "ok" : "malformed",
    handshake: compatible ? "ok" : "malformed",
    status_operational: compatible,
    doctor_operational: compatible,
    channels_consistent: compatible,
    read_authorization: compatible ? "authorized" : "unauthorized",
    write_authorization: writable ? "authorized" : compatible ? "disabled" : "unauthorized",
    authorization_consistent: true,
    data_state: "unknown",
    refresh: { kind: "missing" },
  };
}

export function createSecondBrainProviderReadinessProbe(
  options: ProviderReadinessOptions = {},
): SecondBrainReadinessProbe {
  return {
    inspect: async () => {
      const client = options.open?.()
        ?? new SecondBrainProviderClient(options.provider);
      try {
        return observation(await client.health());
      } catch {
        return unavailable();
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
