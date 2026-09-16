import { dirname } from "node:path";
import type { RenderRoots } from "./personal-os-systemd-roots.js";
import { executablePath, serviceBlock } from "./personal-os-systemd-units.js";

/**
 * The units that are neither the authority nor the provider: the phone gateway and the two halves
 * of the portfolio lane. All three were in the unit inventory with no renderer, so they could not
 * follow the configured roots and the cutover had to repoint them with hand-written drop-ins.
 *
 * The gateway and the collector stay **user** units on purpose, whichever account the authority
 * runs as. The gateway opens no database - it proxies loopback 4173 and serves static assets - and
 * the collector reads the interactive user's own Orca GUI session, which a `nologin` account cannot
 * drive. So they carry no `User=`, and their per-user secrets are named with systemd's `%h`, which
 * is the correct spelling of "the running user's home" for a unit that is always a user unit.
 * Everything they read from the deployment comes from the roots.
 */

/** Where a user unit finds a world-readable copy of the release: the runtime root, or the tree. */
function runtimeRoot(roots: RenderRoots): string {
  // A configured deployment keeps the authority's own tree private to the service account, so a
  // user unit reads the runtime installed beside the bin root instead (the runbook's
  // /opt/jarvis-runtime). An unconfigured installation shares one tree and reads it directly.
  return roots.serviceUser === undefined ? roots.controlCenterCurrent : dirname(roots.binRoot);
}

/**
 * The packaged Orca CLI the collector drives. When the authority has its own account, the roots
 * describe *that* account's trees and not the interactive user's, so a user unit cannot read the
 * Orca CLI from them - it names the running user's own installation with `%h`, exactly as it names
 * that user's signing key. A single-account deployment shares one tree and uses the root directly.
 */
function userOrcaCliRoot(roots: RenderRoots): string {
  return roots.serviceUser === undefined ? roots.orcaCliRoot : "%h/.local/state/orca-jarvis/orca-cli";
}

/**
 * A user unit keeps the deployment's bin root on PATH - it is where `orca-ide` lives - unlike the
 * system units, which deliberately drop it. A deployment whose interpreter already sits in the bin
 * root would otherwise name it twice.
 */
function userPath(roots: RenderRoots): string {
  const nodeDirectory = dirname(roots.nodeBin);
  const entries = nodeDirectory === roots.binRoot ? [nodeDirectory] : [nodeDirectory, roots.binRoot];
  return [...entries, "/usr/bin", "/bin"].join(":");
}

export function phoneGatewayService(roots: RenderRoots): string {
  const runtime = runtimeRoot(roots);
  const envFile = "%h/.config/orca-jarvis/phone-gateway.env";
  return [
    "[Unit]",
    "Description=JM JARVIS phone gateway (tailnet Serve backend, loopback 4176)",
    "After=jm-jarvis-dashboard.service",
    "Requires=jm-jarvis-dashboard.service",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${runtime}`,
    `Environment=PATH=${userPath(roots)}`,
    "Environment=NODE_ENV=production",
    `EnvironmentFile=${envFile}`,
    "UMask=0077",
    `ExecStart=${roots.nodeBin} ${runtime}/dist/src/phone-gateway-main.js --host 127.0.0.1 --port 4176`
      + ` --upstream http://127.0.0.1:4173 --static-root ${runtime}/dist/dashboard --env-file ${envFile}`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "RestrictAddressFamilies=AF_INET",
    "IPAddressDeny=any",
    "IPAddressAllow=localhost",
    "SystemCallArchitectures=native",
    "SystemCallFilter=@system-service",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function portfolioCollectorService(roots: RenderRoots): string {
  const runtime = runtimeRoot(roots);
  return [
    "[Unit]",
    "Description=Collect JM-SERVER portfolio status into the spool",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${runtime}`,
    `Environment=ORCA_EXTRACTED_APPDIR=${userOrcaCliRoot(roots)}/current`,
    `Environment=PATH=${userOrcaCliRoot(roots)}/current/usr/bin:${userOrcaCliRoot(roots)}/bin`
      + `:${userPath(roots)}`,
    "Environment=NODE_ENV=production",
    // Collection opens no database: it signs one envelope and writes it into the spool, so this
    // unit is never a holder of jarvis.sqlite and never blocks the retention lane's exclusion.
    `ExecStart=${roots.nodeBin} ${runtime}/dist/src/cli.js portfolio collect`
      + ` --spool ${roots.portfolioSpool} --source jm-server`
      + " --key-file %h/.config/orca-jarvis/portfolio-jm.key"
      + ` --orca-bin ${roots.binRoot}/orca-ide --git-bin /usr/bin/git`,
    "TimeoutStartSec=50s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${roots.portfolioSpool}`,
    "",
  ].join("\n");
}

export function portfolioCollectorTimer(): string {
  return [
    "[Unit]",
    "Description=Refresh JM-SERVER portfolio status every minute",
    "",
    "[Timer]",
    "OnBootSec=20s",
    "OnUnitActiveSec=60s",
    "AccuracySec=5s",
    "Unit=jm-jarvis-portfolio-collector.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function portfolioIngestService(roots: RenderRoots): string {
  return [
    "[Unit]",
    "Description=Ingest spooled JM-SERVER portfolio envelopes into the authority",
    "After=jm-jarvis.service",
    "Wants=jm-jarvis.service",
    "",
    "[Service]",
    serviceBlock(roots, [
      "Type=oneshot",
      `WorkingDirectory=${roots.authorityCurrent}`,
      `Environment=PATH=${executablePath(roots)}`,
      "Environment=NODE_ENV=production",
      // This half - and only this half - opens the authority database, as the account that owns it,
      // for the length of one bounded batch. The HMAC key must be 0600 and owned by the reading
      // account, so a deployment that splits the accounts gives each its own copy of the key bytes.
      `ExecStart=${roots.nodeBin} ${roots.authorityCurrent}/dist/src/cli.js portfolio ingest`
        + ` --spool ${roots.portfolioSpool} --source jm-server`
        + ` --key-file ${roots.configRoot}/orca-jarvis/portfolio-jm.key --db ${roots.jarvisDb}`,
      "TimeoutStartSec=50s",
      `ReadWritePaths=${dirname(roots.jarvisDb)} ${roots.portfolioSpool}`,
    ]),
    "",
  ].join("\n");
}

export function portfolioIngestTimer(): string {
  return [
    "[Unit]",
    "Description=Ingest spooled JM-SERVER portfolio envelopes every minute",
    "",
    "[Timer]",
    // Offset from the collector so an ingest normally finds a fresh envelope rather than racing it.
    "OnBootSec=50s",
    "OnUnitActiveSec=60s",
    "AccuracySec=5s",
    "Unit=jm-jarvis-portfolio-ingest.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
