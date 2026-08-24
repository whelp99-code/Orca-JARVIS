export type SurfaceName = "web" | "tui" | "electron";

export type ApprovalDisplayFields = {
  readonly requestId: string;
  readonly action: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reversible: boolean;
  readonly digestPrefix: string;
  readonly expiresAt: string;
  readonly host: string;
  readonly environment: string;
  readonly riskTier: number;
};

export type ApprovalSurfaceSnapshot = {
  readonly surface: SurfaceName;
  readonly fields: ApprovalDisplayFields;
  readonly focusOrder: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly roles: Readonly<Record<string, string>>;
};

const FOCUS_ORDER = ["action", "digestPrefix", "approve", "deny"] as const;

export function renderApprovalSurface(surface: SurfaceName, view: ApprovalDisplayFields): ApprovalSurfaceSnapshot {
  return {
    surface,
    fields: view,
    focusOrder: [...FOCUS_ORDER],
    labels: {
      action: `Action ${view.action}`,
      digestPrefix: `Digest ${view.digestPrefix}`,
      approve: "Approve locally",
      deny: "Deny request",
    },
    roles: {
      action: "text",
      digestPrefix: "text",
      approve: "button",
      deny: "button",
    },
  };
}
