export function electronMainSource() {
  return String.raw`const { app, BrowserWindow, Notification, net } = require("electron");
const config = require("./client-config.json");
if (process.argv.includes("--help")) {
  process.stdout.write("JARVIS Electron client\nTASK33_PACKAGED_ELECTRON_HELP_PASS\n"); app.exit(0);
}
let windowRef; let pendingLink; let client;
const deepLinkArg = argv => argv.find(value => typeof value === "string" && value.startsWith("jarvis:"));
pendingLink = deepLinkArg(process.argv);
const lock = app.requestSingleInstanceLock();
if (!lock) { process.stdout.write("ELECTRON_SINGLE_INSTANCE_REDIRECTED\n"); app.quit(); }
app.on("open-url", (event, value) => { event.preventDefault(); pendingLink = value; if (windowRef) void openLink(value); });
app.on("second-instance", (_event, argv) => { const value = deepLinkArg(argv); if (value) pendingLink = value; focus(); if (value) void openLink(value); });
function focus() { if (!windowRef) return; if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); windowRef.focus(); }
async function openLink(value) {
  const { parseJarvisDeepLink } = await import("./electron-deep-link.mjs");
  let parsed;
  try { parsed = parseJarvisDeepLink(value); } catch { process.stderr.write("ELECTRON_DEEP_LINK_INVALID\n"); return; }
  let route = "/";
  if (parsed.kind === "recommendation") {
    try {
      const response = await net.fetch(config.authority_url + "/api/v1/recommendations/" + encodeURIComponent(parsed.recommendationId));
      if (response.status !== 200) throw new Error("unavailable");
      const body = await response.json();
      const action = Array.isArray(body.actions) && body.actions.some(item => item && item.rank === parsed.rank && item.current === true);
      if (!action) throw new Error("unavailable");
      route = "/recommendations/" + encodeURIComponent(parsed.recommendationId) + "?rank=" + parsed.rank;
    } catch { process.stderr.write("ELECTRON_RESOURCE_UNAVAILABLE\n"); }
  }
  focus(); await windowRef.loadURL(config.authority_url + route);
}
function makeTransport() {
  let csrf; let controller;
  const post = async (path, body) => {
    if (!csrf) { const session = await net.fetch(config.authority_url + "/api/v1/session"); csrf = (await session.json()).csrf_token; }
    return net.fetch(config.authority_url + path, { method: "POST", headers: { "Content-Type": "application/json",
      "X-JARVIS-CSRF": csrf, Origin: config.authority_url }, body: JSON.stringify(body) });
  };
  return {
    claim: async () => { const response = await post("/api/v1/notification-deliveries/claim", { schema_version: 1 });
      return response.status === 204 ? null : response.json(); },
    settle: async (id, body) => { const response = await post("/api/v1/notification-deliveries/" + encodeURIComponent(id) + "/settle", body);
      if (response.status !== 200 && response.status !== 410) throw new Error("settle failed"); return response.json(); },
    subscribe: onNotification => {
      controller = new AbortController(); let readyResolve; let connected = false; let lastEventId;
      const ready = new Promise(resolve => { readyResolve = resolve; });
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const headers = lastEventId ? { "Last-Event-ID": lastEventId } : {};
            const response = await net.fetch(config.authority_url + "/api/v1/events", { signal: controller.signal, headers });
            if (!connected) { connected = true; readyResolve(); }
            const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = "";
            for (;;) { const part = await reader.read(); if (part.done) break; buffered += decoder.decode(part.value, { stream: true });
              let boundary; while ((boundary = buffered.indexOf("\n\n")) >= 0) {
                const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
                const id = /^id: ([0-9a-f-]{36}:[1-9]\d*)$/mu.exec(frame)?.[1];
                if (id) lastEventId = id;
                if (id && /^event: (?:snapshot|reconcile)$/mu.test(frame)
                  && frame.includes("personal.notification-intents.v1")) onNotification();
              }
            }
          } catch { if (!controller.signal.aborted) process.stderr.write("LINUX_AUTHORITY_UNAVAILABLE\n"); }
          if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      })();
      return { ready };
    },
    close: () => controller?.abort(),
  };
}
async function createWindow() {
  app.setAsDefaultProtocolClient(config.protocol_scheme);
  windowRef = new BrowserWindow({ width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const authority = new URL(config.authority_url);
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== authority.origin) event.preventDefault(); });
  windowRef.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await windowRef.loadURL(config.authority_url);
  const { createElectronNotificationAdapter, createNotificationDeliveryClient } = await import("./electron-notification-client.mjs");
  const adapter = createElectronNotificationAdapter(Notification, value => { void openLink(value); });
  client = createNotificationDeliveryClient({ transport: makeTransport(), adapter, onError: () => process.stderr.write("LINUX_AUTHORITY_UNAVAILABLE\n") });
  await client.start(); process.stdout.write("TASK33_PACKAGED_ELECTRON_HAPPY_PASS\n");
  if (pendingLink) await openLink(pendingLink);
}
if (lock) app.whenReady().then(createWindow).catch(() => { process.stderr.write("ELECTRON_OPEN_FAILED\n"); app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on("window-all-closed", () => { client?.close(); if (process.platform !== "darwin") app.quit(); });
`;
}
