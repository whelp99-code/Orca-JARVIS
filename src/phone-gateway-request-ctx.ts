import type { IncomingMessage, ServerResponse } from "node:http";
import type { PhoneGatewaySessionStore } from "./dashboard/phone-session.js";
import type { PhoneAuthorityReadAdapter, PhoneErrorCode, PhoneGatewayConfig } from "./phone-gateway-protocol.js";
import type { createPhoneRateLimiter } from "./phone-gateway-adapter.js";
import type { createPhoneMemoryContext } from "./phone-memory-context.js";

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
  readonly memoryContext?: ReturnType<typeof createPhoneMemoryContext>;
  readonly memoryAgentId?: string;
  readonly memoryProfile?: "scoped-record-read-v2" | "scoped-record-read-v3" | "scoped-record-read-v4";
};

export type DispatchUpdate = {
  readonly routeClass?: string;
  readonly outcome?: string;
  readonly code?: PhoneErrorCode | "ok";
  readonly status?: number;
  readonly ownerHex?: string | null;
};
