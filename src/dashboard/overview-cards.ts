export type DashboardOverviewCard = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
};

export function overviewCards(counts: {
  readonly activeWork: number;
  readonly agents: number;
  readonly pending: number;
  readonly risks: number;
}): readonly DashboardOverviewCard[] {
  if (counts.activeWork === 0 && counts.pending === 0 && counts.risks === 0) return [];
  return [
    { id: "active-work", label: "Active work", value: counts.activeWork, detail: counted(counts.activeWork, "task", "in progress") },
    { id: "agents", label: "Agents", value: counts.agents, detail: counted(counts.agents, "live binding") },
    { id: "pending-approvals", label: "Pending approvals", value: counts.pending, detail: counted(counts.pending, "request", "awaiting receipt") },
    { id: "risks", label: "Risks", value: counts.risks, detail: counted(counts.risks, "open risk") },
  ];
}

function counted(count: number, noun: string, suffix?: string): string {
  const word = count === 1 ? noun : `${noun}s`;
  const head = `${String(count)} ${word}`;
  return suffix === undefined ? head : `${head} ${suffix}`;
}
