import { createHash } from "node:crypto";
import type {
  SecondBrainMethod,
  SecondBrainOutcome,
  SecondBrainTransport,
} from "../../src/second-brain-transport.js";

export const NOW = new Date("2026-08-28T12:00:00.000Z");
export const VERSION = "sb/0.1.0|prompt-v1|model-v1";

export function page(
  body = "Prefer cited evidence.[^a1b2c3d4]\n\n[^a1b2c3d4]: me-wiki:principles.md\n",
  overrides: Readonly<Record<string, unknown>> = {},
): SecondBrainOutcome {
  return {
    kind: "data",
    value: {
      frontmatter: {
        id: "wiki/principle",
        title: "Principle",
        updated: "2026-08-28",
        compiled_by: VERSION,
        status: "active",
        sources: "",
        ...overrides,
      },
      body,
    },
  };
}

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export class QueuedTransport implements SecondBrainTransport {
  readonly calls: Array<{ readonly method: SecondBrainMethod; readonly arguments_: Readonly<Record<string, unknown>> }> = [];

  constructor(private readonly outcomes: Array<SecondBrainOutcome | Error>) {}

  async call(method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>): Promise<SecondBrainOutcome> {
    this.calls.push({ method, arguments_ });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new TypeError("fixture outcome missing");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  async restart(): Promise<void> {}
  async close(): Promise<void> {}
  diagnostics(): readonly [] { return []; }
}
