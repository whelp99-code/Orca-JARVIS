import type { KeyObject } from "node:crypto";
import { isAbsolute } from "node:path";
import { JarvisError } from "./db.js";
import { readEd25519PrivateKeyFile } from "./memory-signing-key-file.js";
import { SecondBrainEffectService, type SecondBrainEffectServiceOptions } from "./second-brain-effect-service.js";

/**
 * The JARVIS memory-effect identity a deployment provisioned, named the same way on both sides: the
 * provider's own configuration authorizes this key id, and this is the key it authorized.
 */
export type MemoryEffectSigningConfig = {
  readonly signing_key_id: string;
  readonly private_key_path: string;
};
export type MemoryEffectSigningIdentity = {
  readonly signing_key_id: string;
  readonly private_key: KeyObject;
};
export type ProductionSecondBrainEffectServiceOptions =
  Omit<SecondBrainEffectServiceOptions, "signing_key_id" | "private_key">
  & { readonly signing?: MemoryEffectSigningConfig };

function configured(explicit?: MemoryEffectSigningConfig): MemoryEffectSigningConfig | undefined {
  const values = explicit ?? { signing_key_id: process.env.JARVIS_MEMORY_EFFECT_SIGNING_KEY_ID,
    private_key_path: process.env.JARVIS_MEMORY_EFFECT_PRIVATE_KEY_PATH };
  if (values.signing_key_id === undefined && values.private_key_path === undefined) return undefined;
  if (typeof values.signing_key_id !== "string" || values.signing_key_id.length === 0
    || values.signing_key_id !== values.signing_key_id.normalize("NFC")
    || typeof values.private_key_path !== "string" || !isAbsolute(values.private_key_path)) {
    throw new JarvisError("MEMORY_EFFECT_SIGNING_KEY_INVALID");
  }
  return { signing_key_id: values.signing_key_id, private_key_path: values.private_key_path };
}

/**
 * The provisioned memory-effect signing identity, or a refusal.
 *
 * A read fence this deployment signs is only worth signing if the provider it is sent to authorizes
 * the key id it names. A key generated for the current process can never be that key, so an absent
 * configuration is a refusal (`MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED`) rather than a fallback, and
 * a configuration naming a key this process cannot read as Ed25519 is
 * `MEMORY_EFFECT_SIGNING_KEY_INVALID`. Only a caller that has explicitly decided it is talking to a
 * fixture may supply its own ephemeral key, and it does that through SecondBrainEffectService
 * directly rather than through here.
 */
export function readMemoryEffectSigningIdentity(explicit?: MemoryEffectSigningConfig): MemoryEffectSigningIdentity {
  const config = configured(explicit);
  if (config === undefined) throw new JarvisError("MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED");
  const key = readEd25519PrivateKeyFile(config.private_key_path);
  if (key === undefined) throw new JarvisError("MEMORY_EFFECT_SIGNING_KEY_INVALID");
  return { signing_key_id: config.signing_key_id, private_key: key };
}

/** An effect service that signs with the deployment's provisioned key, or refuses to exist. */
export function createProductionSecondBrainEffectService(
  options: ProductionSecondBrainEffectServiceOptions,
): SecondBrainEffectService {
  const { signing, ...rest } = options;
  return new SecondBrainEffectService({ ...rest, ...readMemoryEffectSigningIdentity(signing) });
}

/**
 * Signing material a composition was handed explicitly.
 *
 * Only a caller that has decided it is talking to a fixture supplies one: a production composition
 * leaves both fields absent and gets the deployment's provisioned identity, or a refusal.
 */
export type MemoryEffectSignerInjection = {
  readonly signing_key_id?: string;
  readonly private_key?: KeyObject;
  readonly signing?: MemoryEffectSigningConfig;
};

/**
 * The identity a production composition signs memory-effect fences with.
 *
 * Absent injection is not a licence to mint a key: it resolves to the provisioned identity through
 * readMemoryEffectSigningIdentity, so a deployment that provisioned none is refused with
 * MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED instead of signing a fence no provider can verify. An
 * injected signer is the fixture path and keeps its own composition's refusal code.
 */
export function composedMemoryEffectSigningIdentity(
  injected: MemoryEffectSignerInjection | undefined, invalid: string,
): MemoryEffectSigningIdentity {
  const keyId = injected?.signing_key_id;
  const privateKey = injected?.private_key;
  if (keyId === undefined && privateKey === undefined) {
    return readMemoryEffectSigningIdentity(injected?.signing);
  }
  if (typeof keyId !== "string" || keyId.length === 0 || privateKey === undefined
    || privateKey.asymmetricKeyType !== "ed25519") {
    throw new JarvisError(invalid);
  }
  return { signing_key_id: keyId, private_key: privateKey };
}
