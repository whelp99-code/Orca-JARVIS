import type { WorkboardActions } from "../workboard/actions.js";
import { parseNativeEveningSourceConfig, type NativeEveningSourceConfig } from "../evening-native-source.js";
import type { TrustedCloseoutKey } from "../evening-closeout-types.js";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { BoundSocket } from "node:net";
import "./bound-socket.js";
import type { CapabilityProbe } from "../capabilities.js";
import type { SecondBrainReadAdapter } from "../second-brain-adapter-types.js";
import type { SecondBrainReadinessProbe } from "../second-brain-readiness.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { OrcaRunner } from "../orca.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import { composeRemoteApproval } from "../remote-approval-compose.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { createDashboardEvents } from "./events.js";
import type { PersonalEventKind } from "./personal-contracts.js";
import { createMemoryRuntime } from "./memory-runtime.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import { DashboardReadModel } from "./read-model.js";
import { createDashboardSession, type DashboardSessionStore } from "./session.js";
import { handleRequest } from "./server-request.js";
import { DashboardTerminalReader } from "./terminal-reader.js";

const LOOPBACK_HOST = "127.0.0.1";

export type DashboardAddress = {
  readonly host: string;
  readonly port: number;
  readonly family: string;
};

export type DashboardServer = {
  readonly address: DashboardAddress;
  publish(topics: readonly string[]): void;
  publishPersonal(kind: PersonalEventKind): void;
  close(): void;
  drain(): Promise<void>;
};

export type DashboardServerOptions = {
  readonly db: AuthorityDb;
  readonly staticRoot: string;
  readonly host: string;
  readonly port: number;
  readonly orcaRunner?: OrcaRunner;
  readonly capabilityProbe?: CapabilityProbe;
  readonly trustedCloseoutKey?: TrustedCloseoutKey;
  readonly nativeCloseoutSource?: NativeEveningSourceConfig;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly planner?: TeamProposalPlanner;
  readonly clock?: () => Date;
  readonly sessionStore?: DashboardSessionStore;
  readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
  readonly executorFactory?: DashboardExecutorFactory;
  readonly memoryAdapter?: SecondBrainReadAdapter;
  readonly memoryProjectionKey?: Buffer;
  readonly memoryEffectSpoolRoot?: string;
  readonly memoryCandidateReviewSpoolRoot?: string;
  readonly memoryCandidateDispatchSpoolRoot?: string;
  readonly memoryReconcileTick?: () => void;
  readonly remoteApproval?: RemoteApprovalService;
  readonly remoteApprovalPolicyPath?: string;
  readonly ownerInbox?: import("../owner-inbox.js").OwnerInbox;
  readonly assertionCheck?: import("../owner-inbox.js").AssertionCheck;
  readonly enrollmentCheck?: import("../owner-inbox-enrollment.js").EnrollmentCheck;
  readonly workboardActions?: WorkboardActions;
  readonly priceFinance?: import("../integration/price-finance-production.js").PriceFinanceRuntime;
};

export function createDashboardServer(options: DashboardServerOptions): DashboardServer & {
  readonly address: { readonly host: string; readonly port: number; readonly family: "IPv4" };
} {
  if (options.host !== LOOPBACK_HOST) throw new JarvisError("LOCAL_SESSION_REQUIRED");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new JarvisError("VALIDATION_ERROR");
  }
  const nativeConfig = options.nativeCloseoutSource === undefined ? undefined : parseNativeEveningSourceConfig(options.nativeCloseoutSource);
  if (nativeConfig !== undefined && options.trustedCloseoutKey === undefined) throw new JarvisError("VALIDATION_ERROR");
  realpathSync(options.staticRoot);
  const remoteApproval = options.remoteApproval ?? composeRemoteApproval(options.db,
    { policyPath: options.remoteApprovalPolicyPath });
  const model = new DashboardReadModel(options.db, options.secondBrainProbe, options.capabilityProbe,
    undefined, undefined, options.trustedCloseoutKey, nativeConfig);
  const terminals = new DashboardTerminalReader(model, options.orcaRunner);
  const events = createDashboardEvents(options.db, options.memoryReconcileTick);
  const session = options.sessionStore ?? createDashboardSession();
  const clock = options.clock ?? (() => new Date());
  const memoryRuntime = createMemoryRuntime({ authority: options.db, session, clock,
    adapter: options.memoryAdapter, projection_key: options.memoryProjectionKey,
    effect_spool_root: options.memoryEffectSpoolRoot,
    candidate_review_spool_root: options.memoryCandidateReviewSpoolRoot,
    candidate_dispatch_spool_root: options.memoryCandidateDispatchSpoolRoot });
  const bind = { origin: `http://${LOOPBACK_HOST}:0` };
  const bound = new BoundSocket({ host: LOOPBACK_HOST, port: options.port });
  const requests = new Set<Promise<void>>();
  const httpServer = createServer((request, response) => {
    const pending = handleRequest({
      db: options.db,
      model,
      terminals,
      staticRoot: options.staticRoot,
      request,
      response,
      hub: events.hub,
      session,
      origin: bind.origin,
      clock,
      capabilityProbe: options.capabilityProbe,
      secondBrainProbe: options.secondBrainProbe,
      planner: options.planner,
      memoryLifecycle: options.memoryLifecycle,
      executorFactory: options.executorFactory,
      memoryRuntime,
      remoteApproval,
      ownerInbox: options.ownerInbox,
      assertionCheck: options.assertionCheck,
      enrollmentCheck: options.enrollmentCheck,
      workboardActions: options.workboardActions,
      priceFinance: options.priceFinance,
    });
    requests.add(pending);
    void pending.then(() => requests.delete(pending), () => requests.delete(pending));
  });
  httpServer.listen(bound);
  const boundAddress = httpServer.address();
  if (boundAddress === null || typeof boundAddress === "string" || boundAddress.family !== "IPv4" || boundAddress.address !== LOOPBACK_HOST) {
    events.close();
    httpServer.closeAllConnections();
    httpServer.close();
    throw new JarvisError("LOCAL_SESSION_REQUIRED");
  }
  bind.origin = `http://${LOOPBACK_HOST}:${boundAddress.port}`;
  return {
    address: { host: LOOPBACK_HOST, port: boundAddress.port, family: "IPv4" },
    publish(topics: readonly string[]): void { events.hub.publish(topics); },
    publishPersonal(kind: PersonalEventKind): void { events.hub.publishPersonal(kind); },
    close(): void { events.close(); httpServer.closeAllConnections(); httpServer.close(); },
    async drain(): Promise<void> { await Promise.allSettled([...requests]); },
  };
}
