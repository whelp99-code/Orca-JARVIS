export type JarvisDeepLink = { readonly kind: "today" }
  | { readonly kind: "recommendation"; readonly recommendationId: string; readonly rank: number };
export class ElectronDeepLinkError extends Error { readonly code: "ELECTRON_DEEP_LINK_INVALID"; }
export function encodeRecommendationDeepLink(recommendationId: string, rank: number): string;
export function parseJarvisDeepLink(value: string): JarvisDeepLink;
export function resolveJarvisRoute(value: string, authorityUrl: string,
  request: (url: string) => Promise<Readonly<{ status: number; json(): Promise<unknown> }>>): Promise<string>;
