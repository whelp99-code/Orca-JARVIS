export function presentPointer(pointer: string | undefined): { readonly production: string | null } {
  return { production: pointer ?? null };
}
