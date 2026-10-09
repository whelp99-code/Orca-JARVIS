/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { createDashboardClient } from "./api.js";
import { createMemoryClient } from "./memory-api.js";
import { createMemoryStore } from "./memory-store.js";
import { createPersonalClient } from "./personal-api.js";
import { createPersonalStore } from "./personal-store.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
import { detectSurface } from "./surface.js";
import type { FinanceReadAdapter } from "./finance-read-adapter.js";
import type { MailCandidatesReadAdapter } from "./mail-candidates-model.js";
import "./styles.css";
import "./styles/content.css";
import "./styles/controls.css";
import "./styles/responsive.css";
import "./styles/portfolio.css";
import "./styles/today.css";
import "./styles/memory.css";
import "./styles/workboard.css";

class DashboardInitializationError extends Error {
  readonly name = "DashboardInitializationError";

  constructor() {
    super("missing-root");
  }
}

// The gateway marks its document; it serves no event stream, so the phone stores poll on demand only.
const surface = detectSurface();
const eventSourceFactory = surface === "phone" ? undefined : (url: string) => new EventSource(url);
const client = createDashboardClient(surface);
const store = createDashboardStore({
  client,
  eventSourceFactory: (url) => new EventSource(url),
});
const personalClient = createPersonalClient(client.session, surface);
const memoryClient = createMemoryClient(client.session);
const memoryStore = createMemoryStore({ client: memoryClient, eventSourceFactory, surface });
const personalStore = createPersonalStore({ client: personalClient, eventSourceFactory });
const rootElement = document.getElementById("root");
if (rootElement === null) throw new DashboardInitializationError();
const root = createRoot(rootElement);
function renderDashboard(financeReadAdapter?: FinanceReadAdapter, mailCandidatesAdapter?: MailCandidatesReadAdapter) {
  root.render(
    <ControlCenterRoot store={store} client={client} personalRuntime={{ store: personalStore, client: personalClient }}
      memoryRuntime={{ store: memoryStore, client: memoryClient }} surface={surface} financeReadAdapter={financeReadAdapter}
      mailCandidatesAdapter={mailCandidatesAdapter} />,
  );
}
if (import.meta.env.DEV && import.meta.env.MODE === "fp5-local" && surface === "local") {
  const state = new URLSearchParams(window.location.search).get("rt");
  const rtState = state === "UNBOUND" || state === "UNAPPROVED" || state === "CONFIRMED" || state === "SOURCE_CHANGED"
    ? state : null;
  void import("./finance-read-adapter.js")
    .then(module => module.createLocalCompositionAdapter(() => new Date(), rtState))
    .then(async adapter => {
      const { createMailCandidatesFixture } = await import("./mail-candidates-fixture.js");
      renderDashboard(adapter, createMailCandidatesFixture());
    });
} else {
  renderDashboard();
}
