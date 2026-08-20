import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PLIST = join(process.cwd(), "deploy/com.jmpark.orca-jarvis-dashboard.plist");
const LABEL = "com.jmpark.orca-jarvis-dashboard";
const NODE = "/Users/jmpark/.nvm/versions/node/v24.19.0/bin/node";
const SERVER = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/current/dist/src/dashboard/server.js";
const WORKING_DIRECTORY = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/current";
const DB = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite";
const STATIC_ROOT = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/current/dist/dashboard";
const LOG_ROOT = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/";
const PATH = "/Users/jmpark/.nvm/versions/node/v24.19.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const SECRET = /private[_ ]?key|begin (?:rsa |ec |openssh )?private|password|secret|csrf|authorization|api[_-]?key|session[_-]?id|receipt|\btoken\b/i;

type LaunchAgent = {
  Label?: string;
  ProgramArguments?: string[];
  WorkingDirectory?: string;
  RunAtLoad?: boolean;
  KeepAlive?: boolean;
  ThrottleInterval?: number;
  StandardOutPath?: string;
  StandardErrorPath?: string;
  EnvironmentVariables?: { NODE_ENV?: string; PATH?: string };
};

function loadPlist(): { text: string; data: LaunchAgent } {
  expect(existsSync(PLIST), `missing ${PLIST}`).toBe(true);
  const lint = spawnSync("/usr/bin/plutil", ["-lint", PLIST], { encoding: "utf8" });
  expect({ status: lint.status, stdout: lint.stdout.trim(), stderr: lint.stderr }).toEqual({
    status: 0,
    stdout: `${PLIST}: OK`,
    stderr: "",
  });
  const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", PLIST], { encoding: "utf8" });
  expect({ status: converted.status, stderr: converted.stderr }).toEqual({ status: 0, stderr: "" });
  return { text: readFileSync(PLIST, "utf8"), data: JSON.parse(converted.stdout) as LaunchAgent };
}

describe("dashboard LaunchAgent definition", () => {
  it("lints and pins the production loopback process", () => {
    const { text, data } = loadPlist();
    expect(data.Label).toBe(LABEL);
    expect(data.RunAtLoad).toBe(true);
    expect(data.KeepAlive).toBe(true);
    expect(data.ThrottleInterval).toBe(10);
    expect(data.WorkingDirectory).toBe(WORKING_DIRECTORY);
    expect(data.ProgramArguments).toEqual([
      NODE,
      SERVER,
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--db",
      DB,
      "--static-root",
      STATIC_ROOT,
    ]);
    expect(data.StandardOutPath?.startsWith(LOG_ROOT)).toBe(true);
    expect(data.StandardErrorPath?.startsWith(LOG_ROOT)).toBe(true);
    expect(data.StandardOutPath).not.toBe(data.StandardErrorPath);
    expect(data.EnvironmentVariables).toEqual({ NODE_ENV: "production", PATH });
    expect(text).toContain("127.0.0.1");
    expect(text).not.toMatch(/0\.0\.0\.0|::[0-9a-f]*|0:0:0:0/i);
    expect(text).not.toMatch(SECRET);
    expect(JSON.stringify(data.EnvironmentVariables)).not.toMatch(SECRET);
  });
});
