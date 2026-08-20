export const FIXTURE_HOST = "127.0.0.1" as const;
export const SEEDED_PORT_1440 = 4174 as const;
export const SEEDED_PORT_1024 = 4176 as const;
export const EMPTY_PORT = 4175 as const;
export const PRODUCTION_PORT = 4173 as const;

export const DECISION_KEY_ID = "decision-test" as const;
export const DECISION_PRINCIPAL = "test-operator" as const;
export const VERIFIER_KEY_ID = "verifier-test" as const;
export const VERIFIER_PRINCIPAL = "independent-verifier" as const;

export const KOREAN_OBJECTIVE =
  "한국어 목표: 관제 센터 대시보드에서 긴 한글 작업 목적이 잘리지 않고 줄바꿈되어야 한다" as const;

export const FIXTURE_SECRET = "sk-proj-e2e-fixture-secret-do-not-leak" as const;
export const FIXTURE_SESSION = "session-secret-e2e-agent" as const;
export const REDACTED = "[REDACTED]" as const;

export const AGENT_TERMINAL = "term-e2e-1" as const;
export const AGENT_INCARNATION = "inc-e2e-1" as const;
export const AGENT_PROVIDER = "codex" as const;

export const IDS = {
  koreanTask: "task-korean-active",
  koreanRun: "run-korean-active",
  koreanRequest: "req-korean-start",
  cancelTask: "task-cancel-active",
  cancelRun: "run-cancel-active",
  cancelRequest: "req-cancel-start",
  pendingApprove: "req-pending-approve",
  pendingApproveTask: "task-pending-approve",
  pendingApproveRun: "run-pending-approve",
  pendingReject: "req-pending-reject",
  pendingRejectTask: "task-pending-reject",
  pendingRejectRun: "run-pending-reject",
  pendingInvalid: "req-pending-invalid",
  pendingInvalidTask: "task-pending-invalid",
  pendingInvalidRun: "run-pending-invalid",
  failedRetry: "req-failed-retry",
  failedRetryTask: "task-failed-retry",
  failedRetryRun: "run-failed-retry",
} as const;

export type FixtureMetadata = {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly decisionKeyPath: string;
  readonly tempRoot: string;
  readonly staticRoot: string;
  readonly agentId?: string;
};

export function seededOrigin(port: number): string {
  return `http://${FIXTURE_HOST}:${String(port)}`;
}

export function emptyOrigin(): string {
  return seededOrigin(EMPTY_PORT);
}

export function productionOrigin(url = process.env.JARVIS_DASHBOARD_URL): string {
  return url === undefined || url.length === 0 ? seededOrigin(PRODUCTION_PORT) : url.replace(/\/$/u, "");
}
