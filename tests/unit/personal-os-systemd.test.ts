import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIsolatedFile } from "../../src/personal-os-protected-paths.js";
import {
  PRODUCTION_ROOTS,
  UNIT_INVENTORY,
  renderSystemdUnit,
} from "../../src/personal-os-systemd.js";

describe("personal-OS systemd renderer", () => {
  it("renders production jm-jarvis.service onto authority/current with loopback hardening", () => {
    // Given / When
    const unit = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: PRODUCTION_ROOTS });

    // Then
    expect(unit).toContain("WorkingDirectory=/home/jm/.local/state/orca-jarvis/authority/current");
    expect(unit).toContain("/home/jm/.nvm/versions/node/v24.19.0/bin/node");
    expect(unit).toContain("dist/src/cli.js service run");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("IPAddressAllow=localhost");
    expect(unit).not.toContain("0.0.0.0");
    expect(unit).not.toContain("/Volumes/DevSpace");
    expect(unit).not.toMatch(/Funnel|launchctl|\.plist/i);
  });

  it("keeps fixture renders free of production state paths and production renders free of attempt paths", () => {
    // Given
    const fixtureRoots = {
      authorityCurrent: "/dev/shm/task36-run/jarvis-releases/current",
      jarvisDb: "/dev/shm/task36-run/state/jarvis/jarvis.sqlite",
      backupRoot: "/dev/shm/task36-run/state/backups",
      providerCurrent: "/dev/shm/task36-run/provider-releases/current",
      providerState: "/dev/shm/task36-run/state/provider",
    };

    // When
    const fixture = renderSystemdUnit({ id: "jm-jarvis-backup.service", mode: "fixture", roots: fixtureRoots });
    const production = renderSystemdUnit({ id: "jm-jarvis-backup.service", mode: "production", roots: PRODUCTION_ROOTS });

    // Then
    expect(fixture).toContain("/dev/shm/task36-run");
    expect(fixture).not.toContain("/home/jm/.local/state/orca-jarvis");
    expect(production).toContain("/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite");
    expect(production).toContain("/home/jm/.local/state/jarvis-rehearsal/backups");
    expect(production).not.toContain("/home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(production).not.toContain("/dev/shm/task36-run");
    expect(production).toContain("UMask=0077");
  });

  it("pins backup timers and matches generated deploy snapshots", () => {
    // Given / When
    const jarvisTimer = renderSystemdUnit({ id: "jm-jarvis-backup.timer", mode: "production", roots: PRODUCTION_ROOTS });
    const providerTimer = renderSystemdUnit({
      id: "jm-second-brain-backup.timer",
      mode: "production",
      roots: PRODUCTION_ROOTS,
    });

    // Then
    expect(jarvisTimer).toContain("OnCalendar=*:0/15");
    expect(jarvisTimer).toContain("Persistent=true");
    expect(jarvisTimer).toContain("RandomizedDelaySec=0");
    expect(providerTimer).toContain("OnCalendar=*-*-* 07:30:00 Asia/Seoul");
    expect(providerTimer).toContain("Persistent=true");
    expect(UNIT_INVENTORY.jarvis).toContain("jm-jarvis.service");
    expect(UNIT_INVENTORY.provider).toContain("jm-second-brain-backup.timer");
    expect(readFileSync("deploy/jm-jarvis.service", "utf8")).toBe(
      renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: PRODUCTION_ROOTS }),
    );
    expect(readFileSync("deploy/jm-jarvis-backup.timer", "utf8")).toBe(jarvisTimer);
    expect(readFileSync("deploy/jm-second-brain-backup.timer", "utf8")).toBe(providerTimer);
    expect(readFileSync("deploy/jm-jarvis-backup.service", "utf8")).toBe(
      renderSystemdUnit({ id: "jm-jarvis-backup.service", mode: "production", roots: PRODUCTION_ROOTS }),
    );
    expect(readFileSync("deploy/jm-second-brain-backup.service", "utf8")).toBe(
      renderSystemdUnit({ id: "jm-second-brain-backup.service", mode: "production", roots: PRODUCTION_ROOTS }),
    );
    expect(readFileSync("deploy/jm-second-brain-requests.service", "utf8")).toBe(
      renderSystemdUnit({ id: "jm-second-brain-requests.service", mode: "production", roots: PRODUCTION_ROOTS }),
    );
  });

  it("keeps rehearsal backup paths outside protected production roots", () => {
    // Given / When / Then
    expect(assertIsolatedFile("/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite")).toBe(
      "/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite",
    );
    expect(() => assertIsolatedFile("/home/jm/.local/state/orca-jarvis/jarvis.sqlite")).toThrow("E_PROTECTED_ROOT");
  });

  it("invokes provider sb without a Node interpreter", () => {
    // Given / When
    const backup = renderSystemdUnit({
      id: "jm-second-brain-backup.service",
      mode: "production",
      roots: PRODUCTION_ROOTS,
    });
    const requests = renderSystemdUnit({
      id: "jm-second-brain-requests.service",
      mode: "production",
      roots: PRODUCTION_ROOTS,
    });

    // Then
    expect(backup).not.toMatch(/bin\/node .*\/bin\/sb/);
    expect(requests).not.toMatch(/bin\/node .*\/bin\/sb/);
    expect(backup).toContain("/bin/sb backup --once --state /home/jm/.local/state/second-brain");
    expect(requests).toContain("/bin/sb apply-requests --once");
  });
});
