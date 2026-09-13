import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MorningRecommendationSource } from "../../src/morning-recommendation-source.js";
import { localObservationChain, LOCAL_CHAIN_AT } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) { const root = dirname(db.filename); db.close(); rmSync(root, { recursive: true, force: true }); }
});

/**
 * A citation says where a thing came from, and the brief is where the owner reads that.
 *
 * Two of the things an action rests on never sat in assembled evidence: the policy decision, and the
 * owner's own approval, which the control plane holds as a signed receipt. Naming the context's own
 * source for those says the assembler produced the owner's approval, which it did not and could
 * not - and a reader checking provenance would be misled by exactly the citation that matters most.
 */
it("names where an owner decision and a policy decision actually come from", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await localObservationChain(db);

  const { source } = new MorningRecommendationSource(db).generate(LOCAL_CHAIN_AT, 256);
  const item = source.input.items[0];
  expect(item).toBeDefined();

  const owner = item?.citations.find(link => link.evidence_ref === "req:local-chain:gate:00");
  expect(owner).toBeDefined();
  expect(owner?.source_id).toBe("src:pos:v1:jarvis:control-plane");

  const policy = item?.citations.find(link => link.evidence_ref === "policy:linux:personal-os-policy-v1:task17");
  expect(policy).toBeDefined();
  expect(policy?.source_id).toBe("src:pos:v1:jarvis:personal-os-policy");

  // And the context's own source is never handed to a citation the context did not hold.
  expect(item?.source_ids).not.toContain("src:pos:v1:jarvis:primary");
}, 60_000);
