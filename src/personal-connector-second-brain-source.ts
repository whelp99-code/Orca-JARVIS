import type { SecondBrainReadAdapter, SecondBrainReadOutcome } from "./second-brain-adapter.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import type { PersonalSourceSnapshot } from "./personal-connector-types.js";
import {
  freezePersonalSnapshot,
  personalConnectorDigest,
  safeConnectorDigest,
  safeConnectorId,
  safeConnectorInstant,
} from "./personal-connector-values.js";

export type SecondBrainConnectorRead =
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "page"; readonly page_id: string }
  | { readonly kind: "recent"; readonly days: number }
  | { readonly kind: "conflicts" };

type SecondBrainSourceOptions = {
  readonly adapter: SecondBrainReadAdapter;
  readonly readiness: SecondBrainReadinessProbe;
  readonly read: SecondBrainConnectorRead;
};

export class SecondBrainPersonalConnectorSource {
  readonly connectorId = "second_brain" as const;
  constructor(private readonly options: SecondBrainSourceOptions) {}

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    const readiness = await buildSecondBrainReadiness(this.options.readiness, now);
    if (readiness.checked_at === null || readiness.readiness === "unavailable" || !readiness.stages.authorized.read) {
      return this.empty(now, "unavailable");
    }
    const outcome = await this.call();
    if (outcome.kind === "invalid" || outcome.kind === "unavailable") return this.empty(now, "unavailable");
    if (outcome.kind === "offline") return this.empty(now, "offline");
    if (outcome.kind === "no_data") {
      return readiness.stages.freshness.state === "fresh" ? this.emptyAt(outcome.checked_at, "no_data") : this.empty(now, "unavailable");
    }
    const evidence = outcome.kind === "conflicts"
      ? outcome.conflicts.flatMap(conflict => [conflict.left, conflict.right])
      : outcome.evidence;
    const digests = evidence.map(item => safeConnectorDigest(item.content_digest)).sort();
    const versions = evidence.map(item => item.source_version).sort();
    const observed = evidence.map(item => safeConnectorInstant(item.observed_at)).sort().at(-1);
    if (observed === undefined || digests.length === 0) return this.empty(now, "unavailable");
    const stale = outcome.kind === "stale" || readiness.stages.freshness.state === "stale";
    const values = {
      evidence_id: digests,
      content_digest: digests,
      source_version: versions.map(value => personalConnectorDigest(value)),
      sensitivity: evidence.map(item => item.sensitivity),
      observed_at: evidence.map(item => item.observed_at),
      ...(outcome.kind === "conflicts" ? { conflict_id: outcome.conflicts.map(item => safeConnectorId(item.conflict_id)) } : {}),
    };
    return freezePersonalSnapshot({
      connector_id: this.connectorId,
      source_version: personalConnectorDigest(versions),
      incarnation: null,
      sequence: Date.parse(outcome.checked_at),
      cursor: personalConnectorDigest({ digests, observed }),
      observed_at: observed,
      status: stale ? "stale" : "current",
      evidence_refs: digests,
      values,
    });
  }

  private call(): Promise<SecondBrainReadOutcome> {
    switch (this.options.read.kind) {
      case "search": return this.options.adapter.search(this.options.read.query);
      case "page": return this.options.adapter.readPage(this.options.read.page_id);
      case "recent": return this.options.adapter.recentChanges(this.options.read.days);
      case "conflicts": return this.options.adapter.openConflicts();
      default: { const exhaustive: never = this.options.read; return exhaustive; }
    }
  }

  private empty(now: Date, status: "offline" | "unavailable"): PersonalSourceSnapshot {
    return this.emptyAt(now.toISOString(), status);
  }

  private emptyAt(observedAt: string, status: "no_data" | "offline" | "unavailable"): PersonalSourceSnapshot {
    const checked = safeConnectorInstant(observedAt);
    return freezePersonalSnapshot({
      connector_id: this.connectorId,
      source_version: "second-brain-v1",
      incarnation: null,
      sequence: Date.parse(checked),
      cursor: personalConnectorDigest({ status, checked }),
      observed_at: checked,
      status,
      evidence_refs: [],
      values: {},
    });
  }
}
