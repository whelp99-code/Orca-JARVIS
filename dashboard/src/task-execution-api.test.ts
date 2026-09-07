import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthorityMutationClient } from "./authority-api.js";
import { parsePreparedExecution, parseTaskExecution } from "./task-execution-guard.js";
import { COMPLETION, EMPTY, HASH, PENDING, PLAN, PREVIEW } from "./task-execution-test-fixture.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
describe("execution HTTP client", () => {
  it("reuses session CSRF for status and allows bounded long-running preparation and execution", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(EMPTY)).mockResolvedValueOnce(response(PREVIEW))
      .mockResolvedValueOnce(response({ schema_version: 1, execution: { request_id: "request-ui", action: "task.execute", state: "completed" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = vi.fn(async () => ({ schema_version: 1 as const, csrf_token: "c".repeat(32) }));
    const client = createAuthorityMutationClient(session);
    expect(await client.taskExecution!.read("task-1")).toEqual(EMPTY);
    await client.taskExecution!.prepare("task-1", { schema_version: 1, run_id: PLAN.run_id, provider: "claude",
      repository_root: "/repo", publication_ref: PLAN.publication.ref, files: [{ path: "answer.mjs", access: "write", exists: true }],
      verification: PLAN.verification, limits: PLAN.limits });
    await client.executeRequest("request-ui");
    expect(session).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toMatchObject(["/api/v1/tasks/task-1/execution", { credentials: "same-origin",
      headers: { "X-JARVIS-CSRF": "c".repeat(32) } }]);
    expect(timeout.mock.calls.map(call => call[0])).toEqual([10000, 45000, 660000]);
  });

  it("rejects cross-task status and incoherent completion evidence", () => {
    expect(parseTaskExecution(EMPTY, "other")).toBeUndefined();
    const completed = { ...EMPTY, requests: [{ ...PENDING, request: { ...PENDING.request, state: "completed" }, completion: COMPLETION }] };
    expect(parseTaskExecution(completed, "task-1")).toEqual(completed);
    for (const completion of [{ ...COMPLETION, request_id: "other" }, { ...COMPLETION, ref: "refs/heads/codex/other" },
      { ...COMPLETION, commit: "made-up" }, { ...COMPLETION, command_digest: `sha256:${"b".repeat(64)}` }]) {
      expect(parseTaskExecution({ ...completed, requests: [{ ...completed.requests[0], completion }] }, "task-1")).toBeUndefined();
    }
    expect(parseTaskExecution({ ...completed, requests: [{ ...completed.requests[0], request: PENDING.request }] }, "task-1")).toBeUndefined();
  });

  it("validates preview identity and keeps unexpected file content out of the client", () => {
    expect(parsePreparedExecution(PREVIEW, "task-1", "run-1")).toEqual(PREVIEW);
    expect(parsePreparedExecution(PREVIEW, "other", "run-1")).toBeUndefined();
    expect(parsePreparedExecution(PREVIEW, "task-1", "other")).toBeUndefined();
    expect(parsePreparedExecution({ ...PREVIEW, repository: { ...PREVIEW.repository, files: [{ ...PREVIEW.repository.files[0], content: "private" }] } },
      "task-1", "run-1")).toBeUndefined();
    expect(parsePreparedExecution({ ...PREVIEW, execution_plan_digest: HASH.replace(/a/g, "b") }, "task-1", "run-1")).toBeUndefined();
  });

  it("does not replay a timed-out execution", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetcher);
    const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: "c".repeat(32) }));
    await expect(client.executeRequest("request-ui")).rejects.toMatchObject({ kind: "offline", code: "OFFLINE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
