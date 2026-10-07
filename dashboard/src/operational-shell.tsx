import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { copy } from "./copy.js";
import type { ConnectionState } from "./store.js";
import { useSurface } from "./surface.js";

type OperationalShellProps = Readonly<{
  connectionState: ConnectionState;
  children: ReactNode;
}>;

const NAV_ITEMS = [
  { label: copy.nav.today, to: "/" },
  { label: copy.nav.memory, to: "/memory" },
  { label: copy.nav.overview, to: "/overview" },
  { label: copy.nav.tasks, to: "/tasks" },
  { label: copy.nav.proposals, to: "/proposals" },
  { label: copy.nav.agents, to: "/agents" },
  { label: copy.nav.approvals, to: "/approvals" },
  { label: copy.nav.security, to: "/security" },
  { label: "조회 준비", to: "/finance-read" },
] as const;
/** The routes the phone gateway serves; every other path is a gateway 404. */
const PHONE_NAV_ITEMS = NAV_ITEMS.filter(item => item.to === "/" || item.to === "/memory" || item.to === "/security");

const CONNECTION_LABELS = {
  connecting: "연결 중",
  live: copy.connected,
  reconnecting: "다시 연결 중",
  offline: copy.disconnected,
} as const satisfies Record<ConnectionState, string>;

const ARGO_REVISION = "de874c1254da8fe170ad7de9c82f11c626349847";

export function OperationalShell({ connectionState, children }: OperationalShellProps) {
  const phone = useSurface() === "phone";
  const items = phone ? PHONE_NAV_ITEMS : NAV_ITEMS;
  // The phone has no authority stream: it is read-only by design, not disconnected.
  const state = phone ? "readonly" : connectionState;
  const label = phone ? copy.readOnly : CONNECTION_LABELS[connectionState];
  return (
    <div className="operational-shell">
      <a className="skip-link" href="#main-content">{copy.skip}</a>
      <header className="control-nav">
        <div className="page-frame control-nav-inner">
          <nav className="primary-nav" aria-label={copy.navLabel}>
            {items.map((item) => (
              <NavLink end={item.to === "/"} key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div
            className="connection-state shell-connection"
            data-state={state}
            role="status"
            aria-label={copy.liveUpdates}
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="connection-icon" aria-hidden="true" />
            <span>{label}</span>
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
