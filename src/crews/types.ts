export type CrewRole = "lead" | "researcher" | "reviewer";

export type CrewMember = {
  readonly id: string;
  readonly role: CrewRole;
  readonly tools: readonly string[];
  readonly model: string;
  readonly workspace: string;
  readonly memory: string;
};

export type CrewBudget = {
  readonly tokens: number;
  readonly timeMs: number;
  readonly toolCalls: number;
  readonly spawnDepth: number;
  readonly concurrentChildren: number;
  readonly cost: number;
};

export type CrewUsage = {
  tokens: number;
  timeMs: number;
  toolCalls: number;
  spawnDepth: number;
  concurrentChildren: number;
  cost: number;
};

export type CrewMail = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly inReplyTo?: string;
  readonly generation: string;
  readonly projectId: string;
  readonly taskId: string;
};
