import { createRoot } from "react-dom/client";
import { createDashboardClient } from "./api.js";
import { createMemoryClient } from "./memory-api.js";
import { createMemoryStore } from "./memory-store.js";
import { createPersonalClient } from "./personal-api.js";
import { createPersonalStore } from "./personal-store.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
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

const client = createDashboardClient();
const store = createDashboardStore({
  client,
  eventSourceFactory: (url) => new EventSource(url),
});
const personalClient = createPersonalClient(client.session);
const memoryClient = createMemoryClient(client.session);
const memoryStore = createMemoryStore({ client: memoryClient,
  eventSourceFactory: url => new EventSource(url) });
const personalStore = createPersonalStore({
  client: personalClient,
  eventSourceFactory: (url) => new EventSource(url),
});
const rootElement = document.getElementById("root");
if (rootElement === null) throw new DashboardInitializationError();
createRoot(rootElement).render(
  <ControlCenterRoot store={store} client={client} personalRuntime={{ store: personalStore, client: personalClient }}
    memoryRuntime={{ store: memoryStore, client: memoryClient }} />,
);
