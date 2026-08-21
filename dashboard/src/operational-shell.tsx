import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { copy } from "./copy.js";
import type { ConnectionState } from "./store.js";

type OperationalShellProps = Readonly<{
  connectionState: ConnectionState;
  children: ReactNode;
}>;

const NAV_ITEMS = [
  { label: copy.nav.overview, to: "/" },
  { label: copy.nav.tasks, to: "/tasks" },
  { label: copy.nav.proposals, to: "/proposals" },
  { label: copy.nav.agents, to: "/agents" },
  { label: copy.nav.approvals, to: "/approvals" },
] as const;

const CONNECTION_LABELS = {
  live: copy.connected,
  reconnecting: "다시 연결 중",
  offline: copy.disconnected,
} as const satisfies Record<ConnectionState, string>;

const ARGO_REVISION = "de874c1254da8fe170ad7de9c82f11c626349847";

export function OperationalShell({ connectionState, children }: OperationalShellProps) {
  return (
    <div className="operational-shell">
      <a className="skip-link" href="#main-content">{copy.skip}</a>
      <header className="control-nav">
        <div className="page-frame control-nav-inner">
          <nav className="primary-nav" aria-label={copy.navLabel}>
            {NAV_ITEMS.map((item) => (
              <NavLink end={item.to === "/"} key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div
            className="connection-state shell-connection"
            data-state={connectionState}
            role="status"
            aria-label={copy.liveUpdates}
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="connection-icon" aria-hidden="true" />
            <span>{CONNECTION_LABELS[connectionState]}</span>
          </div>
        </div>
      </header>
      <main id="main-content" className="operational-shell-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="shell-footer">
        <div className="page-frame shell-footer-inner">
          <a href="/NOTICE-ARGO.txt">
            Argo Workflows attribution, revision {ARGO_REVISION}
          </a>
        </div>
      </footer>
    </div>
  );
}
