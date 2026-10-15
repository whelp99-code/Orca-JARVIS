import { describe, expect, it } from "vitest";
import type { CompanyCheckpoint, CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import { CompanyProgress } from "../../src/company-progress.js";
import { companyApproverV2Database } from "../fixtures/company-approver-execution.js";

type RootCase = {
  readonly name: string;
  readonly corrupt: (next: CompanyCheckpoint, previous: CompanyCheckpoint) => void;
};

const roots: readonly RootCase[] = [
  { name: "intent", corrupt: (next, previous) => { next.intent_root = previous.intent_root; } },
  { name: "revocation", corrupt: (next, previous) => {
    next.revocation_sequence = previous.revocation_sequence + 1;
    next.revocation_root = previous.revocation_root;
  } },
  ...(["jarvis", "second_brain"] as const).flatMap(store =>
    (["receipt", "terminal", "deletion"] as const).map(kind => ({
      name: `${store}.${kind}`,
      corrupt: (next: CompanyCheckpoint, previous: CompanyCheckpoint) => {
        const sequence = `${kind}_sequence` as const;
        const root = `${kind}_root` as const;
        next.stores[store][sequence] = previous.stores[store][sequence] + 1;
        next.stores[store][root] = previous.stores[store][root];
      },
    }))),
];

const NOW = new Date("2026-10-15T00:05:00.000Z");
const EVIDENCE = `sha256:${"e".repeat(64)}`;

describe.each(["reserve", "finish"] as const)("company progress %s response", phase => {
  it.each(roots)("refuses an advanced $name sequence with its previous root", async ({ corrupt }) => {
    const live = await companyApproverV2Database();
    let corrupted = false;
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress(request) {
        const response = live.provider.reserveProgress(request);
        if (phase === "reserve" && response.outcome === "reserved") {
          const reply = structuredClone(response);
          corrupt(reply.checkpoint, request.expected_checkpoint);
          corrupted = true;
          return reply;
        }
        return response;
      },
      finishProgress(request) {
        const response = live.provider.finishProgress(request);
        if (phase === "finish" && response.outcome === "recorded") {
          const reply = structuredClone(response);
          corrupt(reply.checkpoint, request.expected_checkpoint);
          corrupted = true;
          return reply;
        }
        return response;
      },
    };
    try {
      const command = decodeCompanyCommandV2(live.command);
      const progress = new CompanyProgress(live.db, provider);
      const token = phase === "finish" ? progress.reserve(command, "accept", EVIDENCE, NOW) : undefined;
      const checkpoint = live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints");
      const before = checkpoint.get();
      const action = token
        ? () => progress.finish(token, EVIDENCE, "accepted", NOW)
        : () => progress.reserve(command, "accept", EVIDENCE, NOW);

      expect(action).toThrow("COMPANY_PROGRESS_UNCERTAIN");

      expect(corrupted).toBe(true);
      expect(checkpoint.get()).toEqual(before);
      if (token) {
        expect(live.db.db.prepare(
          "SELECT evidence_digest,finished_checkpoint_json,terminal_state FROM company_progress_reservations WHERE operation_id=?",
        ).get(token.operation_id)).toEqual({ evidence_digest: null, finished_checkpoint_json: null, terminal_state: null });
      } else {
        expect(live.db.db.prepare(
          "SELECT count(*) AS n FROM company_progress_reservations WHERE operation='accept'",
        ).get()).toEqual({ n: 0 });
      }
    } finally { live.close(); }
  });
});
