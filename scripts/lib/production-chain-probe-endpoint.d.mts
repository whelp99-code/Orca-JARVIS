export const SHIPPED_PROBE_AT: string;
export const SHIPPED_PROBE_MEMORY_AT: string;
export type ProbeProviderEndpoint =
  | { readonly kind: "installed_release"; readonly launcher: string; readonly config: string }
  | { readonly kind: "development_checkout_fixture_child" };
export function probeProviderEndpoint(environment?: NodeJS.ProcessEnv): ProbeProviderEndpoint;
export function probeInstants(environment?: NodeJS.ProcessEnv): {
  readonly AT: string; readonly CLI_AT: string; readonly MEMORY_AT: string;
  readonly shift_ms: number;
  shifted(value: string): string;
  shift(ms: number): string;
};
export function providerlessEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
