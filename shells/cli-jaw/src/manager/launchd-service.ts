export function enumerateLegacyLabels(): readonly string[] {
  return [];
}

export function disableLegacy(_label: string): { readonly status: "managed_by_jarvis" } {
  return { status: "managed_by_jarvis" };
}
