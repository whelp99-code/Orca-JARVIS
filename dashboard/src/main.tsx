import { createRoot } from "react-dom/client";
import { createDashboardClient } from "./api.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
import "./styles.css";

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
const rootElement = document.getElementById("root");
if (rootElement === null) throw new DashboardInitializationError();
createRoot(rootElement).render(<ControlCenterRoot store={store} client={client} />);
