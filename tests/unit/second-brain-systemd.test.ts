import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const parse = (path: string): Map<string, string[]> => {
  const values = new Map<string, string[]>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("[")) continue;
    const separator = line.indexOf("=");
    expect(separator).toBeGreaterThan(0);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
};

describe("Second Brain Linux user scheduler", () => {
  it("pins a persistent deterministic 07:00 Asia/Seoul user timer", () => {
    // Given / When
    const timer = parse("deploy/jm-second-brain-refresh.timer");

    // Then
    expect(timer.get("OnCalendar")).toEqual(["*-*-* 07:00:00 Asia/Seoul"]);
    expect(timer.get("Persistent")).toEqual(["true"]);
    expect(timer.get("AccuracySec")).toEqual(["1s"]);
    expect(timer.get("RandomizedDelaySec")).toEqual(["0"]);
    expect(timer.get("WantedBy")).toEqual(["timers.target"]);
  });

  it("invokes only a configured external Linux entrypoint with safe home-relative hardening", () => {
    // Given / When
    const text = readFileSync("deploy/jm-second-brain-refresh.service", "utf8");
    const service = parse("deploy/jm-second-brain-refresh.service");

    // Then
    expect(service.get("EnvironmentFile")).toEqual(["%h/.config/jm-second-brain/refresh.env"]);
    expect(service.get("ExecStart")).toEqual(["/usr/bin/env -- ${SECOND_BRAIN_REFRESH_ENTRYPOINT}"]);
    expect(service.get("Type")).toEqual(["oneshot"]);
    expect(service.get("NoNewPrivileges")).toEqual(["true"]);
    expect(service.get("ProtectSystem")).toEqual(["strict"]);
    expect(service.get("ReadWritePaths")).toEqual(["%h/.local/state/second-brain"]);
    expect(text).not.toContain("/home/jm");
    expect(text).not.toContain("960f1c65-7f57-47e3-88f5-80bc5964ee7e");
    expect(text).not.toMatch(/password|token|secret/i);
  });

  it("keeps the request executor fail-closed until signing keys are explicitly enabled", () => {
    const service = parse("deploy/jm-second-brain-requests.service");
    const path = parse("deploy/jm-second-brain-requests.path");

    expect(service.get("Environment")).toEqual([
      "SB_CONFIG=/home/jm/.config/second-brain/config.toml",
    ]);
    expect(service.get("ExecStart")).toEqual([
      "/home/jm/.local/state/second-brain/app/current/bin/sb apply-requests --once",
    ]);
    expect(path.get("ConditionPathExists")).toEqual([
      "/home/jm/.config/second-brain/request-executor.enabled",
    ]);
    expect(path.get("DirectoryNotEmpty")).toEqual([
      "/home/jm/.local/state/second-brain/requests/pending",
    ]);
    expect(path.has("PathExists")).toBe(false);
  });

  it("runs the provider-owned lifecycle maintenance entrypoint with its real config and writable roots", () => {
    const service = parse("deploy/jm-second-brain-backup.service");
    const timer = parse("deploy/jm-second-brain-backup.timer");

    expect(service.get("Environment")).toEqual([
      "SB_CONFIG=/home/jm/.config/second-brain/config.toml",
    ]);
    expect(service.get("ExecStart")).toEqual([
      "/home/jm/.local/state/second-brain/app/current/bin/sb maintain --once",
    ]);
    expect(service.get("ReadWritePaths")).toEqual([
      "/home/jm/.local/state/second-brain /home/jm/.local/share/second-brain",
    ]);
    expect(timer.get("Unit")).toEqual(["jm-second-brain-backup.service"]);
  });
});
