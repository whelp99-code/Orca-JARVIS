import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { JarvisError } from "./db.js";

export type VerificationSpec = {
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly expectedArtifact?: string;
};

export type VerificationAllowlist = {
  readonly commandId: string;
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly cwdRoot: string;
  readonly envAllow: readonly string[];
};

const META = /[;&|`$<>\\\n]/;

export class VerificationExecutor {
  constructor(private readonly allowlist: readonly VerificationAllowlist[]) {}

  run(spec: VerificationSpec): { readonly ok: boolean; readonly evidence: string } {
    const allowed = this.allowlist.find(item => item.commandId === spec.commandId);
    if (!allowed) throw new JarvisError("VERIFY_COMMAND_UNREGISTERED");
    if (spec.argv.some(arg => META.test(arg))) throw new JarvisError("VERIFY_ARGV_INJECTION");
    const cwd = resolve(spec.cwd);
    if (!cwd.startsWith(resolve(allowed.cwdRoot))) throw new JarvisError("VERIFY_CWD_ESCAPE");
    for (const key of Object.keys(spec.env)) {
      if (!allowed.envAllow.includes(key)) throw new JarvisError("VERIFY_ENV_LEAK");
    }
    if (spec.argv[0] !== allowed.executable) throw new JarvisError("VERIFY_ARGV_INJECTION");
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
      cwd,
      env: { ...spec.env },
      encoding: "utf8",
      timeout: spec.timeoutMs,
    });
    if (result.status !== 0) throw new JarvisError("VERIFY_FAILED");
    return { ok: true, evidence: `verify:${spec.commandId}:${result.status}` };
  }
}
