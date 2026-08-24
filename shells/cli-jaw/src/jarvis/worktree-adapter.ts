import { JarvisControlClient } from "./client.js";
import type { CommandIntent } from "./control-protocol.js";

export type ShellWorktreeRequest = {
  readonly ingressIdempotencyKey: string;
  readonly repository: string;
  readonly parentPath: string;
  readonly branch: string;
  readonly name: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
};

export function toWorktreeIntent(request: ShellWorktreeRequest): CommandIntent {
  return {
    ingressIdempotencyKey: request.ingressIdempotencyKey,
    requestedMethod: "command.request",
    target: { repository: request.repository, parent_path: request.parentPath },
    args: { branch: request.branch, name: request.name },
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  };
}

export class JarvisWorktreeAdapter {
  constructor(private readonly client: JarvisControlClient) {}

  requestCreate(request: ShellWorktreeRequest) {
    return this.client.request(toWorktreeIntent(request));
  }
}
