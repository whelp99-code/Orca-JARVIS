import type { IncomingMessage, ServerResponse } from "node:http";
import type { PhoneGatewaySessionStore } from "./dashboard/phone-session.js";
import type { PhoneAuthorityReadAdapter, PhoneErrorCode, PhoneGatewayConfig } from "./phone-gateway-protocol.js";
import type { createPhoneRateLimiter } from "./phone-gateway-adapter.js";

export type PhoneGatewayRequestCtx = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: PhoneGatewayConfig;
  readonly sessions: PhoneGatewaySessionStore;
  readonly limiter: ReturnType<typeof createPhoneRateLimiter>;
  readonly adapter: PhoneAuthorityReadAdapter;
  readonly staticRoot: string;
  readonly assets: ReadonlySet<string>;
  readonly now: () => number;
  readonly audit: (line: string) => void;
  readonly upstream: string;
};

export type DispatchUpdate = {
  readonly routeClass?: string;
  readonly outcome?: string;
  readonly code?: PhoneErrorCode | "ok";
  readonly status?: number;
  readonly ownerHex?: string | null;
};
