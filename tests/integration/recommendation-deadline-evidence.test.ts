import { afterEach, expect, it } from "vitest";
import { AuthorityDb, Recommendations, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { storedRecommendationIdentity } from "../../src/recommendation-identity.js";
import { defaultPriorityCandidates } from "../fixtures/priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { persistTask18Context, RECOMMENDATION_NOW, REPLACEMENT_ID, task18Request, task18Substitute }
  from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
it("stores v1 and v2 recommendations and restores exact v2 deadline evidence after reopening SQLite", async () => {
  const path = tempDb(); const first = new AuthorityDb(path); opened.push(first); await first.migrate();
  const context = await persistTask18Context(first); const recommendations = new Recommendations(first);
  const legacy = recommendations.create(task18Request(context));
  const request = task18Request(context, REPLACEMENT_ID);
  const wanted = new Set(request.ranking.actions.map(action => action.action_id));
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(),
    task18Substitute(context, priorityEngineInput({
      candidates: defaultPriorityCandidates().filter(candidate => wanted.has(String(candidate["action_id"]))),
    })));
  const created = recommendations.create({ ...request, ranking });
  expect(recommendations.create({ ...request, ranking })).toEqual(created);
  first.close(); opened.pop();
  const reopened = new AuthorityDb(path); opened.push(reopened);
  const before = reopened.db.prepare("SELECT total_changes() AS n").get();
  const rows = reopened.db.prepare("SELECT canonical_digest,evidence_digest,canonical_envelope_json FROM personal_recommendations")
    .all() as Record<string, unknown>[];
  const identities = rows.map(row => storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]));
  expect(identities).toHaveLength(2);
  expect(identities.find(item => item.identity_digest === legacy.identity_digest)?.provenance.ranking.schema_version).toBe(1);
  expect(identities.find(item => item.identity_digest === created.identity_digest)?.provenance.ranking).toEqual(ranking);
  expect(new Recommendations(reopened).project(RECOMMENDATION_NOW).next_actions).toHaveLength(6);
  expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});
