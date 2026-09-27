import type { createPhoneMemoryReconcile } from "./phone-memory-reconcile.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PhoneGatewaySessionStore } from "./dashboard/phone-session.js";
import type { PhoneAuthorityReadAdapter, PhoneErrorCode, PhoneGatewayConfig } from "./phone-gateway-protocol.js";
import type { createPhoneRateLimiter } from "./phone-gateway-adapter.js";
import type { createPhoneMemoryContext } from "./phone-memory-context.js";

import type { createPhoneMemoryProviderVerifier } from "./phone-memory-provider-verifier.js";

export type PhoneGatewayRequestCtx = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: PhoneGatewayConfig;
  readonly sessions: PhoneGatewaySessionStore;
  readonly limiter: ReturnType<typeof createPhoneRateLimiter>;
  readonly adapter: PhoneAuthorityReadAdapter;
  readonly staticRoot: string;
  readonly assets: ReadonlySet<string>;
  /** Built dashboard index.html with the phone-mode marker; undefined when the release has none. */
  readonly document: string | undefined;
  readonly now: () => number;
  readonly audit: (line: string) => void;
  readonly upstream: string;
  readonly memoryReconcile?: ReturnType<typeof createPhoneMemoryReconcile>;
  readonly memoryReconcileAgentId?: string;
  readonly memoryProviderVerifier?: ReturnType<typeof createPhoneMemoryProviderVerifier>;
  readonly memoryProviderAgentId?: string;
  readonly memoryContext?: ReturnType<typeof createPhoneMemoryContext>;
  readonly memoryAgentId?: string;
  readonly memoryProfile?: "scoped-record-read-v2" | "scoped-record-read-v3" | "scoped-record-read-v4" | "scoped-record-read-v5";
};

export type DispatchUpdate = {
  readonly routeClass?: string;
  readonly outcome?: string;
  readonly code?: PhoneErrorCode | "ok";
  readonly status?: number;
  readonly ownerHex?: string | null;
};
