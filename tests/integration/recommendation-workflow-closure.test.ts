import { afterEach, expect, it } from "vitest";
import { AuthorityDb, RecommendationWorkflowStager } from "../../src/index.js";
import { verifyRecommendationWorkflowBinding } from "../../src/recommendation-workflow-staging.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import {
  localObservationChain, recordLocalChainPrincipleTask, LOCAL_CHAIN_RECOMMENDATION_ID,
} from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-28T12:01:00.000Z");
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const request = () => ({
  schema_version: 1, recommendation_id: LOCAL_CHAIN_RECOMMENDATION_ID, action_rank: 1,
  requested_by: { principal_id: "principal:owner", authenticated_session_id: "session:owner" },
  target: { repository: "Orca-JARVIS", environment: "local" },
  workflow: { goal: "Do the recommended work", args: { branch: "closure" } },
  budget: { max_steps: 6, max_attempts_per_node: 2 },
  deadline: "2026-08-28T12:02:45.000Z",
});

/**
 * Withdrawing work has to reach the path that would actually do it.
 *
 * The readers already stop offering a recommendation once the owner hides the task its memory came
 * from. Execution asked a different set of questions - digests, lifecycle, expiry - and none of them
 * notice that, so the work the owner withdrew could still be staged, approved and run.
 */
it("refuses to stage or bind a workflow for a recommendation the owner has withdrawn", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await localObservationChain(db);
  const task = recordLocalChainPrincipleTask(db);
  const stager = new RecommendationWorkflowStager(db, () => NOW);

  // While the memory stands, the work can be staged and its binding verifies.
  const staged = stager.stage(request());
  verifyRecommendationWorkflowBinding(db, staged.args, NOW);

  new MemoryProjectionAuthority(db)
    .quarantineUnresolved({ kind: "task_timeline", id: task, component_id: task }, NOW);
  expect(projectRecommendations(db, NOW.toISOString()).next_actions).toEqual([]);

  // The same request now names work this database no longer offers.
  expect(() => stager.stage(request())).toThrow("RECOMMENDATION_MEMORY_SOURCE_CLOSED");
  expect(() => verifyRecommendationWorkflowBinding(db, staged.args, NOW))
    .toThrow("RECOMMENDATION_MEMORY_SOURCE_CLOSED");
}, 60_000);
