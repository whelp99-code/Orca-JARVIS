import { describe, expect, it } from "vitest";
import { redactDashboardValue, redactTerminalLine } from "../../src/dashboard/redaction.js";

const pems = [
  `-----BEGIN PRIVATE KEY-----\n${"A".repeat(63)}\n${"B".repeat(63)}\n-----END PRIVATE KEY-----`,
  `-----BEGIN PUBLIC KEY-----\n${"C".repeat(63)}\n-----END PUBLIC KEY-----`,
  `-----BEGIN CERTIFICATE-----\n${"D".repeat(63)}\n-----END CERTIFICATE-----`,
];

describe("dashboard value redaction", () => {
  it("recursively redacts every secret-keyed value at any depth", () => {
    const record = {
      task_id: "task-1",
      runner: { token: "ghp_abc123", nested: { api_secret: "s3cr3t", keep: "visible" } },
      steps: [{ command: "deploy", environment: { GITHUB_TOKEN: "ghp_xyz" } }],
      authorization: "Bearer abc",
      cookie: "sid=abc123",
    };
    const redacted = redactDashboardValue(record);
    expect(redacted.task_id).toBe("task-1");
    expect(redacted.runner.token).toBe("[REDACTED]");
    expect(redacted.runner.nested.api_secret).toBe("[REDACTED]");
    expect(redacted.runner.nested.keep).toBe("visible");
    expect(redacted.steps[0].command).toBe("deploy");
    expect(redacted.steps[0].environment.GITHUB_TOKEN).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.cookie).toBe("[REDACTED]");
  });

  it("redacts signature, receipt_json, and session_id keys anywhere in the tree", () => {
    const redacted = redactDashboardValue({
      wrapper: { signature: "b".repeat(86), receipt_json: '{"decision":"approve"}', session_id: "session-1" },
    });
    expect(redacted.wrapper.signature).toBe("[REDACTED]");
    expect(redacted.wrapper.receipt_json).toBe("[REDACTED]");
    expect(redacted.wrapper.session_id).toBe("[REDACTED]");
  });

  it("redacts private keys but does not classify public keys or certificates as secrets", () => {
    const redacted = redactDashboardValue({ private_key: pems[0], public_key: pems[1], certificate: pems[2] });
    expect(redacted.private_key).toBe("[REDACTED]");
    expect(redacted.public_key).toBe(pems[1]);
    expect(redacted.certificate).toBe(pems[2]);
  });

  it("preserves safe ids, digests, states, timestamps, numbers, booleans, null, and arrays in order", () => {
    const record = {
      task_id: "task-1",
      request_id: "req-1",
      digest: `sha256:${"a".repeat(64)}`,
      state: "running",
      deadline: "2026-08-10T06:00:00.000Z",
      max_steps: 10,
      reversible: true,
      nothing: null,
      depends_on: ["t-1", "t-2"],
      nested: { digest: `sha256:${"b".repeat(64)}`, flag: false },
    };
    expect(redactDashboardValue(record)).toEqual(record);
  });

  it("caps depth and output size without truncating safe top-level fields", () => {
    const deep = { level1: { level2: { level3: { level4: { level5: { secret: "x" } } } } } };
    const redacted = redactDashboardValue(deep);
    expect(redacted.level1.level2.level3).toBe("[REDACTED]");
    const oversized = { title: "task", tail: "y".repeat(20_000) };
    const bounded = redactDashboardValue(oversized);
    expect(bounded.title).toBe("task");
    expect(bounded.tail).toHaveLength(10_000);
  });

  it("does not mutate its input", () => {
    const record = { headers: { authorization: "Bearer abc" }, safe: "keep" };
    const snapshot = JSON.stringify(record);
    const redacted = redactDashboardValue(record);
    expect(redacted).not.toBe(record);
    expect(redacted.headers).not.toBe(record.headers);
    expect(record.headers.authorization).toBe("Bearer abc");
    expect(record.safe).toBe("keep");
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});

describe("dashboard terminal line redaction", () => {
  it("redacts bearer and basic authorization terminal lines", () => {
    expect(redactTerminalLine("git push https://user:pass@github.com/repo.git")).toBe("[REDACTED]");
    expect(redactTerminalLine("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token.sig' https://api.example.com")).toBe("[REDACTED]");
  });

  it("redacts provider and cloud credential terminal lines", () => {
    for (const line of [
      "export OPENAI_API_KEY=sk-proj-1234567890",
      "export ANTHROPIC_API_KEY=sk-ant-abcdef",
      "export GITHUB_TOKEN=ghp_1234567890",
      "AWS_ACCESS_KEY_ID=AKIA1234567890 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls",
      "az login --client-secret az-client-secret",
      "export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json",
      "gcloud auth activate-service-account --key-file=service-account.json",
    ]) {
      expect(redactTerminalLine(line)).toBe("[REDACTED]");
    }
  });

  it("redacts assignment terminal lines and private-key markers", () => {
    for (const line of [
      "JAWS_API_KEY=supersecretvalue",
      "export JAWS_API_KEY=supersecretvalue",
      "run: npx jarvis approve --token tkn-abc123",
      "npx jarvis control approve --session-id session-1",
      `cat > key.pem <<'EOF'\n${pems[0]}\nEOF`,
    ]) {
      expect(redactTerminalLine(line)).toBe("[REDACTED]");
    }
  });

  it("preserves ordinary command output", () => {
    for (const line of [
      "checkout main",
      "finished in 12.4s",
      "commit 3f2a1b built successfully",
      "task-1 running since 2026-08-10T06:00:00.000Z",
    ]) {
      expect(redactTerminalLine(line)).toBe(line);
    }
  });
});
