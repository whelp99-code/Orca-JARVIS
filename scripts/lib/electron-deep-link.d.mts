export type JarvisDeepLink = { readonly kind: "today" }
  | { readonly kind: "recommendation"; readonly recommendationId: string; readonly rank: number };
export class ElectronDeepLinkError extends Error { readonly code: "ELECTRON_DEEP_LINK_INVALID"; }
export function encodeRecommendationDeepLink(recommendationId: string, rank: number): string;
export function parseJarvisDeepLink(value: string): JarvisDeepLink;
export type DeepLinkRequest = (url: string) => Promise<Readonly<{ status: number;
  headers: Readonly<{ get(name: string): string | null }>; json(): Promise<unknown> }>>;
export function resolveJarvisRoute(value: string, authorityUrl: string, request: DeepLinkRequest): Promise<string>;
export function createDeepLinkCoordinator(options: Readonly<{ authorityUrl: string; request: DeepLinkRequest;
  navigate(route: string): void | Promise<void>;
  onError(code: "ELECTRON_DEEP_LINK_INVALID" | "ELECTRON_RESOURCE_UNAVAILABLE"): void;
}>): Readonly<{ open(value: string): Promise<void> }>;
