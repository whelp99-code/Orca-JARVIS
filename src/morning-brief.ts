import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export type MorningSourceState = Readonly<{
	source_id: string;
	state: "fresh" | "stale" | "offline" | "unavailable" | "no_data";
	detail: string;
	checked_at: string;
}>;
export type MorningAction = Readonly<{
	action_id: string;
	title: string;
	rank: number;
	citation_ids: readonly string[];
	state?: "ready" | "blocked";
}>;
export type MorningBriefInput = Readonly<{
	loop_date: string;
	now: string;
	refresh: Readonly<{
		state: "fresh" | "stale" | "failed" | "capped" | "no_data";
		completed_at: string | null;
		source_id: string;
	}>;
	sources: readonly MorningSourceState[];
	actions: readonly MorningAction[];
	blocked: readonly string[];
	decisions: readonly string[];
	workers: readonly string[];
	risks: readonly string[];
}>;
export type MorningBrief = Readonly<{
	schema_version: 1;
	loop_date: string;
	state: "fresh" | "degraded";
	sections: Readonly<{
		now: readonly MorningAction[];
		blocked: readonly string[];
		decisions: readonly string[];
		next_three: readonly MorningAction[];
		workers: readonly string[];
		risks: readonly string[];
	}>;
	source_health: readonly MorningSourceState[];
	warnings: readonly string[];
	digest: string;
}>;

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function validTime(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

export function generateMorningBrief(input: MorningBriefInput): MorningBrief {
	if (!validTime(input.now) || !/^\d{4}-\d{2}-\d{2}$/.test(input.loop_date)) throw new Error("MORNING_BRIEF_INPUT_INVALID");
	const now = new Date(input.now);
	const deadline = new Date(Date.parse(`${input.loop_date}T07:20:00+09:00`));
	const refreshFresh =
		input.refresh.state === "fresh" &&
		input.refresh.completed_at !== null &&
		validTime(input.refresh.completed_at) &&
		input.refresh.completed_at.slice(0, 10) === input.loop_date;
	const withinDeadline = now.getTime() <= deadline.getTime();
	const warnings = input.sources.filter((source) => source.state !== "fresh").map((source) => `${source.source_id}:${source.state}:${source.detail}`);
	if (!refreshFresh) warnings.push(`second_brain_refresh:${input.refresh.state}`);
	if (!withinDeadline) warnings.push("refresh_deadline_exceeded");
	const state: "fresh" | "degraded" = refreshFresh && withinDeadline && warnings.length === 0 ? "fresh" : "degraded";
	const ranked = [...input.actions].sort((left, right) => left.rank - right.rank || left.action_id.localeCompare(right.action_id));
	const next_three = ranked.slice(0, 3);
	const payload = {
		schema_version: 1 as const,
		loop_date: input.loop_date,
		state,
		sections: {
			now: next_three.filter((action) => action.state !== "blocked"),
			blocked: [...input.blocked],
			decisions: [...input.decisions],
			next_three,
			workers: [...input.workers],
			risks: [...input.risks],
		},
		source_health: [...input.sources],
		warnings,
	};
	return { ...payload, digest: digest(payload) };
}
