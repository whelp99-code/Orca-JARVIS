import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OPERATIONS = "docs/personal-os/operations.md";
const DISASTER = "docs/personal-os/disaster-recovery.md";
const RELEASE = "docs/personal-os/release.md";
const QUIZ_KEY = "docs/personal-os/operator-quiz-key.json";
const QUIZ = "docs/personal-os/operator-quiz.json";
const COMMAND_POLICY = "config/command-policy.json";

describe("personal-OS operator documents", () => {
  it("retires historical release docs as non-executable and keeps Linux docs as the operator surface", () => {
    // Given
    const controlCenter = readFileSync("docs/control-center-release.md", "utf8");
    const jm = readFileSync("docs/jm-control-center-release.md", "utf8");
    const release = readFileSync(RELEASE, "utf8");

    // Then
    expect(controlCenter).toContain("HISTORICAL_NON_EXECUTABLE");
    expect(jm).toContain("HISTORICAL_NON_EXECUTABLE");
    expect(release).toContain("jarvis-authority-releases");
    expect(release).not.toContain("docs/control-center-release.md as executable");
  });

  it("locks quiz tokens, citations, and command-policy shape without hashing the policy file internally", () => {
    // Given
    const key = JSON.parse(readFileSync(QUIZ_KEY, "utf8")) as {
      readonly questions: readonly {
        readonly id: number;
        readonly required_tokens: readonly string[];
        readonly allowed_docs: readonly string[];
        readonly min_citations: number;
      }[];
    };
    const answers = JSON.parse(readFileSync(QUIZ, "utf8")) as {
      readonly answers: readonly {
        readonly id: number;
        readonly tokens: readonly string[];
        readonly citations: readonly string[];
      }[];
    };
    const policy = JSON.parse(readFileSync(COMMAND_POLICY, "utf8")) as {
      readonly schema_version: number;
      readonly commands: Record<string, unknown>;
    };
    const docs = [
      readFileSync(OPERATIONS, "utf8"),
      readFileSync(DISASTER, "utf8"),
      readFileSync(RELEASE, "utf8"),
    ].join("\n");

    // Then
    expect(key.questions).toHaveLength(10);
    expect(answers.answers).toHaveLength(10);
    expect(policy.schema_version).toBe(1);
    expect(policy).not.toHaveProperty("digest");
    expect(policy).not.toHaveProperty("sha256");
    expect(Object.keys(policy).sort()).toEqual(["commands", "schema_version"]);
    for (const question of key.questions) {
      const answer = answers.answers.find((row) => row.id === question.id);
      expect(answer?.tokens).toEqual(question.required_tokens);
      expect((answer?.citations.length ?? 0) >= question.min_citations).toBe(true);
      for (const token of question.required_tokens) expect(docs).toContain(token);
    }
  });
});
