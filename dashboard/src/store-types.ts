import type {
  AgentListResponse,
  ControlRequestListResponse,
  OverviewResponse,
  TaskListResponse,
} from "../../src/dashboard/read-model.js";
import type { ApiError, ApiErrorKind, DashboardClient } from "./api.js";
import type { TaskExecutionResource } from "./task-execution-resource.js";
import type { TaskExecutionOperation } from "./task-execution-operations.js";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";
export type ResourceState<T> =
  | { readonly status: "idle" | "loading" | "retrying"; readonly kind?: never }
  | { readonly status: "success"; readonly data: T; readonly kind?: never }
  | { readonly status: "empty"; readonly data: T; readonly kind?: never }
  | { readonly status: "error"; readonly kind: ApiErrorKind; readonly error: ApiError };
export type DashboardState = {
  readonly connectionState: ConnectionState;
  readonly overview: ResourceState<OverviewResponse>;
  readonly tasks: ResourceState<TaskListResponse>;
  readonly agents: ResourceState<AgentListResponse>;
  readonly approvals: ResourceState<ControlRequestListResponse>;
  readonly taskExecution?: TaskExecutionResource;
  readonly taskExecutionOperations?: readonly TaskExecutionOperation[];
};
export type EventSourceLike = {
  readonly readyState?: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};
export type DashboardStoreOptions = {
  readonly client: DashboardClient;
  readonly eventSourceFactory: (url: string) => EventSourceLike;
};
