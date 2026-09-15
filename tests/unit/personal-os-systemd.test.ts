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
  // The daily loop is scheduled by the unit only when the deployment configured its inputs. The
  // generator inventing those paths would turn a host that never provisioned them into a crash
  // loop, because `service run` refuses one flag without the other.
  it("renders the daily loop's inputs only once the deployment configures them", () => {
    // Given
    const configured = { ...SERVICE_ENVIRONMENT,
      JARVIS_DAILY_SERVICE_CONFIG: "/var/lib/jarvis-svc/state/orca-jarvis/daily/service-config.json",
      JARVIS_DAILY_CLOSEOUT_KEY: "/var/lib/jarvis-svc/state/orca-jarvis/daily/daily-closeout.key" };

    // When
    const off = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: productionRoots({}) });
    const on = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: productionRoots(configured) });

    // Then
    // Silently off, and visibly so: the flags are simply absent from the invocation.
    expect(off).toContain("dist/src/cli.js service run --db /home/jm/.local/state/orca-jarvis/jarvis.sqlite\n");
    expect(off).not.toContain("--input");
    expect(off).not.toContain("--key-file");
    // Configured, and therefore load-bearing: the service fails closed on these inputs.
    expect(on).toContain(
      "dist/src/cli.js service run --db /var/lib/jarvis-svc/state/orca-jarvis/jarvis.sqlite"
      + " --input /var/lib/jarvis-svc/state/orca-jarvis/daily/service-config.json"
      + " --key-file /var/lib/jarvis-svc/state/orca-jarvis/daily/daily-closeout.key",
    );
    // Half a configuration is refused where the operator can read it, not by a restarting unit.
    for (const half of [{ JARVIS_DAILY_SERVICE_CONFIG: "/var/lib/jarvis-svc/daily/service-config.json" },
      { JARVIS_DAILY_CLOSEOUT_KEY: "/var/lib/jarvis-svc/daily/daily-closeout.key" }]) {
      expect(() => productionRoots({ ...SERVICE_ENVIRONMENT, ...half })).toThrow("E_DEPLOYMENT_ROOT");
    }
  });

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

  // Gap G5 of the cutover: the generator set ProtectHome=yes on the strength of JARVIS_SERVICE_USER
  // alone, so a deployment that deliberately left the provider under /home (decision 1.1) had to
  // override it by hand in a drop-in. ProtectHome now follows the provider roots, not the account.
  it("derives ProtectHome and the provider write paths from where the provider roots resolve", () => {
    // Given
    const awayFromHome = productionRoots(SERVICE_ENVIRONMENT);
    const providerUnderHome = productionRoots({
      ...SERVICE_ENVIRONMENT,
      JARVIS_PROVIDER_STATE_ROOT: "/home/jm/.local/state/second-brain",
      JARVIS_PROVIDER_CONFIG: "/home/jm/.config/second-brain/config.toml",
      JARVIS_PROVIDER_SHARE_ROOT: "/home/jm/.local/share/second-brain",
    });

    // When
    const away = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: awayFromHome });
    const under = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: providerUnderHome });
    const underDashboard = renderSystemdUnit({
      id: "jm-jarvis-dashboard.service", mode: "production", roots: providerUnderHome,
    });

    // Then
    // Nothing configured inside a home: /home is invisible, and no provider tree is writable.
    expect(away).toContain("ProtectHome=yes");
    expect(away).not.toContain("second-brain");
    // The provider stayed under /home, so the unit says read-only and names exactly the two trees
    // the spawned MCP child writes — the config directory stays readable, never writable.
    expect(under).toContain("ProtectHome=read-only");
    expect(under).not.toContain("ProtectHome=yes");
    expect(under).toContain(
      "ReadWritePaths=/home/jm/.local/state/second-brain /home/jm/.local/share/second-brain");
    expect(under).not.toContain("ReadWritePaths=/home/jm/.config/second-brain");
    // Every unit of that deployment shares the /home visibility; only the authority spawns the
    // provider child, so only the authority gets the provider write paths.
    expect(underDashboard).toContain("ProtectHome=read-only");
    expect(underDashboard).not.toContain("second-brain");
    // The per-user installation is unchanged: read-only /home and no rendered provider write path.
    const perUser = renderSystemdUnit({ id: "jm-jarvis.service", mode: "production", roots: productionRoots({}) });
    expect(perUser).toContain("ProtectHome=read-only");
    expect(perUser).not.toContain("second-brain");
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
