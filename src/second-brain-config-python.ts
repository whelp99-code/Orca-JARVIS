import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const SECOND_BRAIN_CONFIG_PYTHON = "/usr/bin/python3";
export const SECOND_BRAIN_CONFIG_PYTHON_TIMEOUT_MS = 5_000;
export const SECOND_BRAIN_CONFIG_PYTHON_SCRIPT = `import sys, tomllib
raw = sys.stdin.buffer.read(65537)
try:
    if len(raw) < 1 or len(raw) > 65536:
        raise ValueError()
    value = tomllib.loads(raw.decode("utf-8", errors="strict"))
    root = value.get("vault_root") if isinstance(value, dict) else None
    if not isinstance(root, str) or not root:
        raise ValueError()
    sys.stdout.write("VALID\\n")
except (UnicodeDecodeError, tomllib.TOMLDecodeError, ValueError):
    sys.stdout.write("MALFORMED\\n")
`;

const STDOUT_MAX_BYTES = 32;
const STDERR_MAX_BYTES = 1_024;
const SAFE_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  PYTHONIOENCODING: "utf-8",
} as const;

export type SecondBrainConfigProcessRequest = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Uint8Array;
  readonly timeout_ms: number;
  readonly stdout_max_bytes: number;
  readonly stderr_max_bytes: number;
};
export type SecondBrainConfigProcessResult =
  | { readonly kind: "completed"; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "unavailable" | "timeout" | "oversize" | "stdin_failure" };
export type SecondBrainConfigProcessRunner = (
  request: SecondBrainConfigProcessRequest,
) => Promise<SecondBrainConfigProcessResult>;
export type SecondBrainConfigParser = (bytes: Uint8Array) => Promise<"valid" | "malformed" | "unavailable">;

export async function parseSecondBrainConfigWithPython(
  bytes: Uint8Array,
  runner: SecondBrainConfigProcessRunner = runSecondBrainConfigProcess,
): Promise<"valid" | "malformed" | "unavailable"> {
  const result = await runner({
    command: SECOND_BRAIN_CONFIG_PYTHON,
    args: ["-I", "-c", SECOND_BRAIN_CONFIG_PYTHON_SCRIPT],
    env: SAFE_ENV,
    stdin: bytes,
    timeout_ms: SECOND_BRAIN_CONFIG_PYTHON_TIMEOUT_MS,
    stdout_max_bytes: STDOUT_MAX_BYTES,
    stderr_max_bytes: STDERR_MAX_BYTES,
  });
  if (result.kind !== "completed" || result.code !== 0 || result.signal !== null || result.stderr !== "") {
    return "unavailable";
  }
  if (result.stdout === "VALID\n") return "valid";
  return result.stdout === "MALFORMED\n" ? "malformed" : "unavailable";
}

export async function runSecondBrainConfigProcess(
  request: SecondBrainConfigProcessRequest,
): Promise<SecondBrainConfigProcessResult> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.command, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      env: { ...request.env },
    });
  } catch {
    return { kind: "unavailable" };
  }
  return supervise(child, request);
}

function supervise(
  child: ChildProcessWithoutNullStreams,
  request: SecondBrainConfigProcessRequest,
): Promise<SecondBrainConfigProcessResult> {
  return new Promise(resolve => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let failure: "unavailable" | "timeout" | "oversize" | "stdin_failure" | undefined;
    const fail = (kind: typeof failure): void => {
      if (failure !== undefined) return;
      failure = kind;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk, request.stdout_max_bytes, () => fail("oversize"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk, request.stderr_max_bytes, () => fail("oversize"));
    });
    child.once("error", () => fail("unavailable"));
    child.stdin.once("error", () => fail("stdin_failure"));
    const timeout = setTimeout(() => fail("timeout"), request.timeout_ms);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure !== undefined) {
        resolve({ kind: failure });
        return;
      }
      resolve({
        kind: "completed",
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    child.stdin.end(request.stdin);
  });
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer | string,
  maximum: number,
  oversize: () => void,
): Buffer<ArrayBufferLike> {
  const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  if (current.byteLength + incoming.byteLength > maximum) {
    oversize();
    return Buffer.alloc(0);
  }
  return Buffer.concat([current, incoming]);
}
