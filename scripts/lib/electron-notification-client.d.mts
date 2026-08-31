export class ElectronProtocolError extends Error { readonly code: "ELECTRON_PROTOCOL_INVALID"; }
export class ElectronNotificationError extends Error { readonly code: string; }
export type NotificationPayload = Readonly<{ title: string; summary: string; alert_class: string; deep_link: string }>;
export interface NotificationLike {
  once(event: string, listener: () => void): this;
  show(): void;
}
export interface NotificationType {
  isSupported(): boolean;
  new(options: Readonly<{ title: string; body: string }>): NotificationLike;
}
export interface NotificationAdapter {
  isSupported(): boolean;
  show(input: Readonly<{ deliveryId: string; payload: NotificationPayload; signal: AbortSignal }>): Promise<string>;
}
export function parseSessionResponse(value: unknown): Readonly<{ schema_version: 1; csrf_token: string }>;
export function parseClaimResponse(status: number, value: unknown): Readonly<{
  schema_version: 1; delivery_id: string; intent_id: string; expires_at: string; payload: NotificationPayload;
}> | null;
export function parseSettlementResponse(status: number, value: unknown): Readonly<{
  schema_version: 1; delivery_id: string; intent_id: string; state: "delivered" | "failed" | "expired"; settled_at: string;
}>;
export function parseSseFrame(frame: string): Readonly<{ id: string | null;
  type: "snapshot" | "reconcile" | "heartbeat"; notification: boolean }>;
export function createElectronNotificationAdapter(type: NotificationType, onClick: (link: string) => void): NotificationAdapter;
export function createNotificationDeliveryClient(options: Readonly<{
  transport: Readonly<{ subscribe(listener: () => void): Readonly<{ ready: Promise<void> }>;
    claim(): Promise<Readonly<{ delivery_id: string; payload: NotificationPayload }> | null>;
    settle(id: string, body: unknown): Promise<void>; close(): void }>;
  adapter: NotificationAdapter; onError(error: unknown): void;
}>): Readonly<{ start(): Promise<void>; close(): void }>;
