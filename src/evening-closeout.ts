import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export type CloseoutCompletion = Readonly<{
	item_id: string;
	summary: string;
	evidence_refs: readonly string[];
	verification_id: string | null;
}>;
export type CloseoutOpenItem = Readonly<{
	item_id: string;
	state: "blocked" | "failed" | "incomplete";
	reason: string;
}>;
export type EveningCloseoutInput = Readonly<{
	loop_date: string;
	run_id: string;
	completions: readonly CloseoutCompletion[];
	open_items: readonly CloseoutOpenItem[];
	decisions: readonly string[];
	candidate_ids: readonly string[];
	improvements: readonly string[];
	tomorrow_first_action: string | null;
	now: string;
}>;
export type EveningCloseout = Readonly<
	EveningCloseoutInput & {
		schema_version: 1;
		digest: string;
		state: "complete" | "incomplete";
	}
>;

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
function text(value: string, max: number): string {
	if (!value || value.length > max) throw new Error("CLOSEOUT_TEXT_INVALID");
	return value;
}

export function createEveningCloseout(input: EveningCloseoutInput): EveningCloseout {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.loop_date) || !input.run_id || !Number.isFinite(Date.parse(input.now))) throw new Error("CLOSEOUT_INPUT_INVALID");
	for (const completion of input.completions) {
		text(completion.item_id, 256);
		text(completion.summary, 1024);
		if (completion.evidence_refs.length === 0 || completion.evidence_refs.some((ref) => !ref || ref.length > 256) || !completion.verification_id)
			throw new Error("CLOSEOUT_EVIDENCE_REQUIRED");
	}
	for (const item of input.open_items) {
		text(item.item_id, 256);
		text(item.reason, 1024);
	}
	const payload = {
		schema_version: 1 as const,
		loop_date: input.loop_date,
		run_id: input.run_id,
		completions: input.completions,
		open_items: input.open_items,
		decisions: [...input.decisions],
		candidate_ids: [...new Set(input.candidate_ids)],
		improvements: [...input.improvements],
		tomorrow_first_action: input.tomorrow_first_action,
		now: input.now,
		state: input.open_items.length === 0 ? ("complete" as const) : ("incomplete" as const),
	};
	return { ...payload, digest: digest(payload) };
}
