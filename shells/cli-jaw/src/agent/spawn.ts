import { assertSpawnAllowed, type ShellTrustProfile } from "../jarvis/trust-profile.js";

export function spawnRuntime(profile: ShellTrustProfile | undefined, runtimeId: string): { readonly started: true; readonly runtimeId: string } {
  assertSpawnAllowed(profile, runtimeId);
  return { started: true, runtimeId };
}
