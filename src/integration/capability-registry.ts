import { JarvisError } from "../jarvis-error.js";
import { personalConnectorDefinition } from "../personal-connector-definitions.js";
import { isCore5IntegrationEnabled } from "./flag.js";
import { CORE5_INTEGRATION_CAPABILITIES, type Core5IntegrationCapability } from "./types.js";

export type RegisteredCapability = {
  readonly id: Core5IntegrationCapability;
  readonly enabled: boolean;
  readonly status: "available" | "degraded" | "blocked";
  readonly live_send: false;
  readonly owner: "jarvis_execution";
};

const LIVE_SEND_CAPABILITIES = Object.freeze(["mail.send"] as const);

export class Core5CapabilityRegistry {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  enabled(): boolean {
    return isCore5IntegrationEnabled(this.env);
  }

  list(): readonly RegisteredCapability[] {
    const enabled = this.enabled();
    return CORE5_INTEGRATION_CAPABILITIES.map(id => Object.freeze({
      id,
      enabled,
      status: this.statusFor(id, enabled),
      live_send: false as const,
      owner: "jarvis_execution" as const,
    }));
  }

  get(id: string): RegisteredCapability {
    if ((LIVE_SEND_CAPABILITIES as readonly string[]).includes(id)) {
      throw new JarvisError("CORE5_LIVE_SEND_NOT_REGISTERED", id);
    }
    const found = this.list().find(item => item.id === id);
    if (found === undefined) throw new JarvisError("CORE5_CAPABILITY_UNKNOWN", id);
    return found;
  }

  requireEnabled(id: Core5IntegrationCapability): RegisteredCapability {
    const item = this.get(id);
    if (!item.enabled) throw new JarvisError("CORE5_INTEGRATION_DISABLED", id);
    if (item.status === "blocked") throw new JarvisError("CORE5_CAPABILITY_BLOCKED", id);
    return item;
  }

  personalMailConfigured(): boolean {
    return personalConnectorDefinition("mail").configured;
  }

  private statusFor(id: Core5IntegrationCapability, enabled: boolean): RegisteredCapability["status"] {
    if (!enabled) return "blocked";
    const key = `CORE5_CAPABILITY_STATUS_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const requested = this.env[key]?.toLowerCase();
    if (requested === "degraded") return "degraded";
    if (requested === "blocked") return "blocked";
    return "available";
  }
}
