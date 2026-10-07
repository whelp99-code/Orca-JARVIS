import { useEffect, useSyncExternalStore } from "react";
import type { OverviewResponse, ControlRequestListResponse } from "../../src/dashboard/read-model.js";
import type { AuthorityMutationClient } from "./authority-api.js";
import type { PersonalClient } from "./personal-api.js";
import type { PersonalStore } from "./personal-store.js";
import type { ConnectionState } from "./store-types.js";
import type { ResourceState } from "./store.js";
import { copy } from "./copy.js";
import { TodayPage } from "./today-page.js";

export type PersonalRuntime = Readonly<{ store: PersonalStore; client: PersonalClient }>;

type Props = Readonly<{
  runtime?: PersonalRuntime;
  overview: ResourceState<OverviewResponse>;
  approvals: ResourceState<ControlRequestListResponse>;
  authorityClient: AuthorityMutationClient;
  authorityConnection: ConnectionState;
}>;

export function TodayRoute({ runtime, overview, approvals, authorityClient, authorityConnection }: Props) {
  if (runtime === undefined) {
    return <div className="page-frame route-state"><section role="alert"><h1>{copy.pages.today}</h1><p>{copy.today.unavailable}</p></section></div>;
  }
  return (
    <LiveTodayRoute runtime={runtime} overview={overview} approvals={approvals}
      authorityClient={authorityClient} authorityConnection={authorityConnection} />
  );
}

function LiveTodayRoute({ runtime, overview, approvals, authorityClient, authorityConnection }: Required<Props>) {
  const snapshot = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot, runtime.store.getSnapshot);
  useEffect(() => {
    runtime.store.start();
    return () => runtime.store.stop();
  }, [runtime.store]);
  return (
    <TodayPage
      snapshot={snapshot}
      overview={resourceData(overview)}
      approvals={resourceData(approvals)?.items ?? []}
      client={runtime.client}
      authorityClient={authorityClient}
      authorityConnected={authorityConnection === "live"}
      onRefresh={() => { void runtime.store.refresh(); }}
    />
  );
}

function resourceData<T>(state: ResourceState<T>): T | undefined {
  switch (state.status) {
    case "success":
    case "empty":
      return state.data;
    case "idle":
    case "loading":
    case "retrying":
    case "error":
      return undefined;
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected resource state: ${JSON.stringify(value)}`);
}
