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

function stringValue(text: string, key: string): string {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  expect(match, `missing string ${key}`).not.toBeNull();
  return match?.[1] ?? "";
}

function integerValue(text: string, key: string): number {
  const match = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(text);
  expect(match, `missing integer ${key}`).not.toBeNull();
  return Number(match?.[1]);
}

function boolValue(text: string, key: string): boolean {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(text);
  expect(match, `missing bool ${key}`).not.toBeNull();
  return match?.[1] === "true";
}

function stringArray(text: string, key: string): string[] {
  const block = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(text);
  expect(block, `missing array ${key}`).not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].flatMap((entry) => (
    entry[1] === undefined ? [] : [entry[1]]
  ));
}

function envValues(text: string): { NODE_ENV?: string; PATH?: string } {
  const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  expect(block, "missing EnvironmentVariables").not.toBeNull();
  return {
    NODE_ENV: stringValue(block?.[1] ?? "", "NODE_ENV"),
    PATH: stringValue(block?.[1] ?? "", "PATH"),
  };
}

function loadPlist(): { text: string; data: LaunchAgent } {
  expect(existsSync(PLIST), `missing ${PLIST}`).toBe(true);
  if (existsSync("/usr/bin/plutil")) {
    const lint = spawnSync("/usr/bin/plutil", ["-lint", PLIST], { encoding: "utf8" });
    expect({ status: lint.status, stdout: lint.stdout.trim(), stderr: lint.stderr }).toEqual({
      status: 0,
      stdout: `${PLIST}: OK`,
      stderr: "",
    });
  }
  const text = readFileSync(PLIST, "utf8");
  return {
    text,
    data: {
      Label: stringValue(text, "Label"),
      ProgramArguments: stringArray(text, "ProgramArguments"),
      WorkingDirectory: stringValue(text, "WorkingDirectory"),
      RunAtLoad: boolValue(text, "RunAtLoad"),
      KeepAlive: boolValue(text, "KeepAlive"),
      ThrottleInterval: integerValue(text, "ThrottleInterval"),
      StandardOutPath: stringValue(text, "StandardOutPath"),
      StandardErrorPath: stringValue(text, "StandardErrorPath"),
      EnvironmentVariables: envValues(text),
    },
  };
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
