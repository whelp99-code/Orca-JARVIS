import type { TerminalEvent, TerminalEventInput } from "./terminal-memory-types.js";
import { TerminalMemoryError, boundedEvidence, identifier, safeSummary, timestamp } from "./terminal-memory-validation.js";
import { TerminalWorkMemory, type SqlSource } from "./terminal-work-memory.js";

export type ShellFallbackInput = Readonly<
  TerminalEventInput & {
    orca_available: false;
    collector_id: string;
    cwd_digest: string;
  }
>;
export type ShellFallbackResult = Readonly<{ accepted: true; event: TerminalEvent }>;

export class ShellFallbackCollector {
  private readonly memory: TerminalWorkMemory;

  constructor(source: SqlSource) {
    this.memory = new TerminalWorkMemory(source);
  }

  ingest(input: ShellFallbackInput): ShellFallbackResult {
    if (input.orca_available !== false) {
      throw new TerminalMemoryError("SHELL_FALLBACK_NOT_REQUIRED");
    }
    identifier(input.collector_id);
    identifier(input.cwd_digest);
    timestamp(input.occurred_at);
    const forbiddenKey = Object.keys(input).some((key) =>
      /keypress|stdin|password|private[_ -]?reasoning|secret|token/i.test(key),
    );
    if (forbiddenKey) {
      throw new TerminalMemoryError("SHELL_FALLBACK_FORBIDDEN_FIELD");
    }
    const serialized = JSON.stringify(input);
    if (
      serialized &&
      /(?:password|passwd|secret|api[_ -]?key|private[_ -]?key|authorization)\s*[:=]/iu.test(
        serialized,
      )
    ) {
      throw new TerminalMemoryError("SHELL_FALLBACK_REDACTION_REQUIRED");
    }
    boundedEvidence(input.stdout);
    boundedEvidence(input.stderr);
    safeSummary(input.command_class);
    return {
      accepted: true,
      event: this.memory.recordEvent(input),
    };
  }
}

export function ingestShellFallback(
  source: SqlSource,
  input: ShellFallbackInput,
): ShellFallbackResult {
  return new ShellFallbackCollector(source).ingest(input);
}
