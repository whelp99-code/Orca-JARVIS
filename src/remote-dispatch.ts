import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { EnvironmentRegistry, type EnvironmentId } from "./remote-environment.js";

export type RemoteEffectRequest = {
  readonly effectId: string;
  readonly action: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly environment: EnvironmentId;
  readonly generation: string;
  readonly fingerprint: string;
  readonly exclusiveCapability?: string;
};

export type RemoteEffectState = "leased" | "invoked" | "completed" | "uncertain" | "waiting_environment";

export type RemoteEffect = {
  readonly effectKey: string;
  readonly owner: EnvironmentId;
  readonly generation: string;
  readonly state: RemoteEffectState;
  readonly invocations: number;
  readonly receipt?: string;
};

export type OrcaSurface = (args: readonly string[]) => Promise<string>;

export function logicalEffectKey(request: Pick<RemoteEffectRequest, "effectId" | "action" | "target" | "environment">): string {
  return `sha256:${createHash("sha256").update(canonicalize({
    effectId: request.effectId,
    action: request.action,
    target: request.target,
    environment: request.environment,
  })).digest("hex")}`;
}

export class RemoteDispatch {
  private readonly effects = new Map<string, RemoteEffect>();
  private transferEnabled = true;
  constructor(private readonly registry: EnvironmentRegistry, private readonly orca: OrcaSurface) {}

  setTransferEnabled(enabled: boolean): void {
    this.transferEnabled = enabled;
  }

  async dispatch(request: RemoteEffectRequest, barrier?: "after-invoke"): Promise<RemoteEffect> {
    const env = this.registry.get(request.environment);
    if (request.exclusiveCapability && !env.capabilities.includes(request.exclusiveCapability)) {
      if (!env.available) return this.store({ effectKey: logicalEffectKey(request), owner: request.environment, generation: request.generation, state: "waiting_environment", invocations: 0 });
    }
    if (!env.available && request.exclusiveCapability) {
      return this.store({ effectKey: logicalEffectKey(request), owner: request.environment, generation: request.generation, state: "waiting_environment", invocations: 0 });
    }
    this.registry.require(request.environment, request.fingerprint, request.generation);
    const key = logicalEffectKey(request);
    const existing = this.effects.get(key);
    if (existing && (existing.state === "completed" || existing.state === "uncertain" || existing.state === "invoked")) return existing;
    if (existing && existing.owner !== request.environment) throw new JarvisError("ENVIRONMENT_LEASE_HELD");
    const leased: RemoteEffect = { effectKey: key, owner: request.environment, generation: request.generation, state: "leased", invocations: existing?.invocations ?? 0 };
    this.effects.set(key, leased);
    await this.orca(["worktree", "show", "--environment", request.environment, "--json"]);
    const invoked: RemoteEffect = { ...leased, state: "invoked", invocations: leased.invocations + 1 };
    this.effects.set(key, invoked);
    if (barrier === "after-invoke") return invoked;
    return this.settle(key, request.generation, `ok:${request.environment}`);
  }

  settle(effectKey: string, generation: string, receipt: string): RemoteEffect {
    const current = this.effects.get(effectKey);
    if (!current) throw new JarvisError("REMOTE_EFFECT_UNKNOWN");
    if (current.generation !== generation) throw new JarvisError("ENVIRONMENT_STALE_GENERATION");
    if (current.state === "uncertain") throw new JarvisError("REMOTE_EFFECT_UNCERTAIN");
    const completed: RemoteEffect = { ...current, state: "completed", receipt };
    this.effects.set(effectKey, completed);
    return completed;
  }

  loseLease(effectKey: string): RemoteEffect {
    const current = this.effects.get(effectKey);
    if (!current) throw new JarvisError("REMOTE_EFFECT_UNKNOWN");
    if (current.state === "invoked" || current.state === "leased") {
      const uncertain: RemoteEffect = { ...current, state: "uncertain" };
      this.effects.set(effectKey, uncertain);
      this.transferEnabled = false;
      return uncertain;
    }
    return current;
  }

  transfer(effectKey: string, to: EnvironmentId): RemoteEffect {
    if (!this.transferEnabled) throw new JarvisError("REMOTE_TRANSFER_DISABLED");
    const current = this.effects.get(effectKey);
    if (!current) throw new JarvisError("REMOTE_EFFECT_UNKNOWN");
    if (current.state === "invoked" || current.state === "uncertain") throw new JarvisError("REMOTE_TRANSFER_UNSUPPORTED");
    throw new JarvisError("REMOTE_TRANSFER_UNSUPPORTED");
  }

  get(effectKey: string): RemoteEffect | undefined {
    return this.effects.get(effectKey);
  }

  private store(effect: RemoteEffect): RemoteEffect {
    this.effects.set(effect.effectKey, effect);
    return effect;
  }
}
