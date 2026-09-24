export type PurposeSource = "owner" | "explicit_request" | "agent_summary";
export type PurposeEvidence = { kind: PurposeSource | "raw_log"; ref: string };
export type Purpose = { project_id: string; text: string; source: PurposeEvidence; version: number };
export type WorkPurposeBinding = {
  work_id: string; project_id: string; purpose: Purpose | null;
  why: string | null; evidence: PurposeEvidence | null;
  status: "confirmed" | "proposed" | "unknown";
  needs_reconfirmation: boolean;
};
export type ActionPurposeRef = { work_id: string; purpose_version: number; work_spec_revision: string };
