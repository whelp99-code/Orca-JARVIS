import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIsolatedFile } from "../../src/personal-os-protected-paths.js";
import {
  type GeneratedUnitId,
  UNIT_INVENTORY,
  isolatedRenderRoots,
  productionRoots,
  renderSystemdUnit,
} from "../../src/personal-os-systemd.js";

/** The environment the cutover installs: the authority owned by a dedicated service account. */
const SERVICE_ENVIRONMENT = {
  JARVIS_STATE_ROOT: "/var/lib/jarvis-svc/state/orca-jarvis",
  JARVIS_PROVIDER_STATE_ROOT: "/var/lib/jarvis-svc/state/second-brain",
  JARVIS_PROVIDER_CONFIG: "/var/lib/jarvis-svc/config/second-brain/config.toml",
  JARVIS_PROVIDER_SHARE_ROOT: "/var/lib/jarvis-svc/share/second-brain",
  JARVIS_CONFIG_ROOT: "/var/lib/jarvis-svc/config",
  JARVIS_BIN_ROOT: "/opt/jarvis-runtime/bin",
  JARVIS_NODE_BIN: "/opt/jarvis-runtime/bin/node",
  JARVIS_SERVICE_USER: "jarvis-svc",
} as const;

const GENERATED_IDS: readonly GeneratedUnitId[] = [
  "jm-jarvis.service", "jm-jarvis-dashboard.service", "jm-jarvis-backup.service",
  "jm-jarvis-backup.timer", "jm-second-brain-backup.service", "jm-second-brain-backup.timer",
  "jm-second-brain-requests.service", "jm-second-brain-requests.path",
];

describe("personal-OS systemd renderer", () => {
  it("renders production jm-jarvis.service onto authority/current with loopback hardening", () => {
    // Given / When
    const unit = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: productionRoots({}) });

    // Then
    expect(unit).toContain("WorkingDirectory=/home/jm/.local/state/orca-jarvis/authority/current");
    expect(unit).toContain("/home/jm/.nvm/versions/node/v24.19.0/bin/node");
    expect(unit).toContain("Environment=PATH=/home/jm/.nvm/versions/node/v24.19.0/bin:/home/jm/.local/bin:/usr/bin:/bin");
    expect(unit).toContain("dist/src/cli.js service run");
    expect(unit).toContain("dist/src/cli.js db migrate --db /home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(unit).toContain("ReadWritePaths=/home/jm/.local/state/orca-jarvis");
    expect(unit).not.toContain("ReadWritePaths=/home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectHome=read-only");
    expect(unit).toContain("IPAddressAllow=localhost");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
    expect(unit).not.toContain("0.0.0.0");
    expect(unit).not.toContain("/Volumes/DevSpace");
    expect(unit).not.toMatch(/Funnel|launchctl|\.plist/i);
  });

  it("renders every generated unit for the service account without naming the interactive user", () => {
    // Given
    const roots = productionRoots(SERVICE_ENVIRONMENT);

    // When
    const units = GENERATED_IDS.map(id => renderSystemdUnit({ id, mode: "production", roots }));

    // Then
    // The whole point of the migration: nothing a system unit executes, reads or writes may live
    // under the interactive user's home, because /home/jm is unreachable for the service account.
    for (const unit of units) expect(unit).not.toContain("/home/jm");
    const [authority, dashboard] = units;
    expect(authority).toContain("User=jarvis-svc");
    expect(authority).toContain("Group=jarvis-svc");
    // A service account keeps nothing in a home directory, so /home is made invisible outright.
    expect(authority).toContain("ProtectHome=yes");
    expect(authority).not.toContain("ProtectHome=read-only");
    expect(authority).toContain("ReadWritePaths=/var/lib/jarvis-svc/state/orca-jarvis");
    expect(authority).toContain(
      "ExecStart=/opt/jarvis-runtime/bin/node /var/lib/jarvis-svc/state/orca-jarvis/authority/current"
      + "/dist/src/cli.js service run --db /var/lib/jarvis-svc/state/orca-jarvis/jarvis.sqlite",
    );
    expect(authority).toContain("Environment=PATH=/opt/jarvis-runtime/bin:/usr/bin:/bin");
    // A system unit is wanted by the system's own target, not by a per-user default.target.
    expect(authority).toContain("WantedBy=multi-user.target");
    expect(authority).not.toContain("WantedBy=default.target");
    expect(dashboard).toContain("--host 127.0.0.1 --port 4173");
    expect(dashboard).toContain("--db /var/lib/jarvis-svc/state/orca-jarvis/jarvis.sqlite");
    expect(dashboard).toContain("User=jarvis-svc");
    // Every hardening directive the per-user installation had survives the move.
    for (const directive of ["UMask=0077", "NoNewPrivileges=true", "PrivateTmp=true",
      "ProtectSystem=strict", "RestrictSUIDSGID=true", "LockPersonality=true",
      "SystemCallArchitectures=native"]) {
      expect(authority).toContain(directive);
      expect(dashboard).toContain(directive);
    }
  });

  it("moves the provider units onto the configured provider roots and marker", () => {
    // Given / When
    const roots = productionRoots(SERVICE_ENVIRONMENT);
    const backup = renderSystemdUnit({ id: "jm-second-brain-backup.service", mode: "production", roots });
    const requests = renderSystemdUnit({ id: "jm-second-brain-requests.service", mode: "production", roots });
    const path = renderSystemdUnit({ id: "jm-second-brain-requests.path", mode: "production", roots });

    // Then
    expect(backup).toContain("Environment=SB_CONFIG=/var/lib/jarvis-svc/config/second-brain/config.toml");
    expect(backup).toContain("ExecStart=/var/lib/jarvis-svc/state/second-brain/app/current/bin/sb maintain --once");
    expect(backup).toContain(
      "ReadWritePaths=/var/lib/jarvis-svc/state/second-brain /var/lib/jarvis-svc/share/second-brain");
    expect(requests).toContain(
      "ExecStart=/var/lib/jarvis-svc/state/second-brain/app/current/bin/sb apply-requests --once");
    expect(path).toContain(
      "ConditionPathExists=/var/lib/jarvis-svc/config/second-brain/request-executor.enabled");
    expect(path).toContain("DirectoryNotEmpty=/var/lib/jarvis-svc/state/second-brain/requests/pending");
  });

  it("keeps fixture renders isolated and production backups bound to live authority state", () => {
    // Given
    const fixtureRoots = isolatedRenderRoots({ root: "/dev/shm/task36-run/state" });

    // When
    const fixture = renderSystemdUnit({ id: "jm-jarvis-backup.service", mode: "fixture", roots: fixtureRoots });
    const production = renderSystemdUnit({
      id: "jm-jarvis-backup.service", mode: "production", roots: productionRoots({}),
    });

    // Then
    expect(fixture).toContain("/dev/shm/task36-run");
    expect(fixture).not.toContain("/home/jm/.local/state/orca-jarvis");
    expect(production).toContain("/home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(production).toContain("/home/jm/.local/state/orca-jarvis/backups --production");
    expect(fixture).not.toContain("--production");
    expect(production).toContain("ReadWritePaths=/home/jm/.local/state/orca-jarvis");
    expect(production).not.toContain("/home/jm/.local/state/jarvis-rehearsal");
    expect(production).not.toContain("/dev/shm/task36-run");
    expect(production).toContain("UMask=0077");
  });

  it("pins backup timers and matches generated deploy snapshots", () => {
    // Given / When
    const roots = productionRoots({});
    const jarvisTimer = renderSystemdUnit({ id: "jm-jarvis-backup.timer", mode: "production", roots });
    const providerTimer = renderSystemdUnit({ id: "jm-second-brain-backup.timer", mode: "production", roots });

    // Then
    expect(jarvisTimer).toContain("OnCalendar=*:0/15");
    expect(jarvisTimer).toContain("Persistent=true");
    expect(jarvisTimer).toContain("RandomizedDelaySec=0");
    expect(providerTimer).toContain("OnCalendar=*-*-* 07:30:00 Asia/Seoul");
    expect(providerTimer).toContain("Persistent=true");
    expect(UNIT_INVENTORY.jarvis).toContain("jm-jarvis.service");
    expect(UNIT_INVENTORY.provider).toContain("jm-second-brain-backup.timer");
    // Every generated unit's committed deploy artifact is the renderer's own output for the
    // unconfigured deployment, so a root that moved in code and not in deploy/ fails here.
    for (const id of GENERATED_IDS) {
      expect(readFileSync(`deploy/${id}`, "utf8"))
        .toBe(renderSystemdUnit({ id, mode: "production", roots }));
    }
  });

  it("keeps rehearsal backup paths outside protected production roots", () => {
    // Given / When / Then
    expect(assertIsolatedFile("/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite")).toBe(
      "/home/jm/.local/state/jarvis-rehearsal/jarvis.sqlite",
    );
    expect(() => assertIsolatedFile("/home/jm/.local/state/orca-jarvis/jarvis.sqlite")).toThrow("E_PROTECTED_ROOT");
  });

  it("invokes provider-owned maintenance and requests without a Node interpreter", () => {
    // Given / When
    const roots = productionRoots({});
    const backup = renderSystemdUnit({ id: "jm-second-brain-backup.service", mode: "production", roots });
    const requests = renderSystemdUnit({ id: "jm-second-brain-requests.service", mode: "production", roots });

    // Then
    expect(backup).not.toMatch(/bin\/node .*\/bin\/sb/);
    expect(requests).not.toMatch(/bin\/node .*\/bin\/sb/);
    expect(backup).toContain("Environment=SB_CONFIG=/home/jm/.config/second-brain/config.toml");
    expect(backup).toContain("/home/jm/.local/state/second-brain/app/current/bin/sb maintain --once");
    expect(backup).toContain("ReadWritePaths=/home/jm/.local/state/second-brain /home/jm/.local/share/second-brain");
    expect(requests).toContain("/home/jm/.local/state/second-brain/app/current/bin/sb apply-requests --once");
  });
});
