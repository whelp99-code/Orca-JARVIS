import { useEffect, useState } from "react";
import { classifyDashboardError } from "./api.js";
import type { ResourceState } from "./store.js";

type ResourceRequest<T> = Readonly<{
  id: string;
  state: ResourceState<T>;
}>;

function alwaysPopulated(): boolean {
  return true;
}

export function useDetailResource<T>(
  id: string,
  load: (resourceId: string) => Promise<T>,
  hasContent: (value: T) => boolean = alwaysPopulated,
  refreshKey?: string,
): ResourceState<T> {
  const [request, setRequest] = useState<ResourceRequest<T>>({
    id,
    state: { status: "loading" },
  });

  useEffect(() => {
    let active = true;
    setRequest({ id, state: { status: "loading" } });
    void load(id).then(
      (data) => {
        if (!active) return;
        setRequest({ id, state: hasContent(data) ? { status: "success", data } : { status: "empty", data } });
      },
      (error: unknown) => {
        if (!active) return;
        const classified = classifyDashboardError(error);
        setRequest({ id, state: { status: "error", kind: classified.kind, error: classified } });
      },
    );
    return () => {
      active = false;
    };
  }, [hasContent, id, load, refreshKey]);

  return request.id === id ? request.state : { status: "loading" };
}
