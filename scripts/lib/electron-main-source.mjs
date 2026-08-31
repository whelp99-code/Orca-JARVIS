export function electronMainSource() {
  return String.raw`const { app, BrowserWindow, Notification, net } = require("electron");
const config = require("./client-config.json");
if (process.argv.includes("--help")) {
  process.stdout.write("JARVIS Electron client\nTASK33_PACKAGED_ELECTRON_HELP_PASS\n"); app.exit(0);
}
let windowRef; let pendingLink; let client; let deepLinkCoordinator;
const driverObservations = process.argv.includes("--task33-driver-observe");
const observe = marker => { if (driverObservations) process.stdout.write(marker + "\n"); };
const deepLinkArg = argv => argv.find(value => typeof value === "string" && value.startsWith("jarvis:"));
pendingLink = deepLinkArg(process.argv);
const lock = app.requestSingleInstanceLock();
if (!lock) { process.stdout.write("ELECTRON_SINGLE_INSTANCE_REDIRECTED\n"); app.quit(); }
app.on("open-url", (event, value) => { event.preventDefault(); pendingLink = value; if (windowRef) void openLink(value); });
app.on("second-instance", (_event, argv) => { void handleSecondInstance(argv); });
async function handleSecondInstance(argv) {
  const value = deepLinkArg(argv);
  try {
    if (value === undefined) throw new TypeError("invalid link");
    const deepLinks = await import("./electron-deep-link.mjs"); deepLinks.parseJarvisDeepLink(value);
  } catch { process.stderr.write("ELECTRON_DEEP_LINK_INVALID\n"); observe("TASK33_OBSERVE_INVALID_SECOND"); return; }
  pendingLink = value; await openLink(value);
}
function focus() {
  if (!windowRef) return; observe("TASK33_OBSERVE_FOCUS");
  if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); windowRef.focus();
}
async function openLink(value) {
  if (!deepLinkCoordinator) { pendingLink = value; return; }
  await deepLinkCoordinator.open(value);
}
function makeTransport(protocol, metrics) {
  let csrf; let controller;
  const json = async response => {
    if (!/^application\/json(?:; charset=utf-8)?$/iu.test(response.headers.get("content-type") ?? "")) {
      throw new protocol.ElectronProtocolError();
    }
    return response.json();
  };
  const post = async (path, body) => {
    if (!csrf) {
      const session = await net.fetch(config.authority_url + "/api/v1/session");
      if (session.status !== 200) throw new protocol.ElectronProtocolError();
      csrf = protocol.parseSessionResponse(await json(session)).csrf_token;
    }
    return net.fetch(config.authority_url + path, { method: "POST", headers: { "Content-Type": "application/json",
      "X-JARVIS-CSRF": csrf, Origin: config.authority_url }, body: JSON.stringify(body) });
  };
  return {
    claim: async () => {
      metrics.claims += 1;
      const response = await post("/api/v1/notification-deliveries/claim", { schema_version: 1 });
      const value = response.status === 204 ? undefined : await json(response);
      return protocol.parseClaimResponse(response.status, value);
    },
    settle: async (id, body) => {
      metrics.settles += 1;
      const response = await post("/api/v1/notification-deliveries/" + encodeURIComponent(id) + "/settle", body);
      return protocol.parseSettlementResponse(response.status, await json(response));
    },
    subscribe: onNotification => {
      observe("TASK33_OBSERVE_SSE_CLIENT");
      controller = new AbortController(); let readyResolve; let connected = false; let lastEventId;
      const ready = new Promise(resolve => { readyResolve = resolve; });
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const headers = lastEventId ? { "Last-Event-ID": lastEventId } : {};
            const response = await net.fetch(config.authority_url + "/api/v1/events", { signal: controller.signal, headers });
            if (response.status !== 200 || !/^text\/event-stream(?:; charset=utf-8)?$/iu
              .test(response.headers.get("content-type") ?? "") || !response.body) throw new protocol.ElectronProtocolError();
            if (!connected) { connected = true; readyResolve(); }
            const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = "";
            for (;;) { const part = await reader.read(); if (part.done) break; buffered += decoder.decode(part.value, { stream: true });
              let boundary; while ((boundary = buffered.indexOf("\n\n")) >= 0) {
                const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
                try {
                  const parsed = protocol.parseSseFrame(frame);
                  if (parsed.id !== null) lastEventId = parsed.id;
                  if (parsed.notification) onNotification();
                } catch (error) {
                  if (error instanceof protocol.ElectronProtocolError) process.stderr.write("ELECTRON_PROTOCOL_INVALID\n");
                  else throw error;
                }
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) process.stderr.write(error instanceof protocol.ElectronProtocolError
              ? "ELECTRON_PROTOCOL_INVALID\n" : "LINUX_AUTHORITY_UNAVAILABLE\n");
          }
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
  windowRef = new BrowserWindow({ width: 1280, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  observe("TASK33_OBSERVE_WINDOW");
  const authority = new URL(config.authority_url);
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== authority.origin) event.preventDefault(); });
  windowRef.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await windowRef.loadURL(config.authority_url);
  const deepLinks = await import("./electron-deep-link.mjs");
  deepLinkCoordinator = deepLinks.createDeepLinkCoordinator({ authorityUrl: config.authority_url,
    request: async url => net.fetch(url), focus, navigate: async route => {
      focus(); await windowRef.loadURL(config.authority_url + route); observe("TASK33_OBSERVE_NAVIGATION");
      process.stdout.write("TASK33_DEEP_LINK_OPENED route=" + (route === "/" ? "today" : "recommendation") + "\n");
    }, onError: code => process.stderr.write(code + "\n") });
  const protocol = await import("./electron-notification-client.mjs");
  const metrics = { claims: 0, shows: 0, settles: 0 };
  const nativeAdapter = protocol.createElectronNotificationAdapter(Notification, value => {
    process.stdout.write("TASK33_NATIVE_NOTIFICATION_CLICK\n"); void openLink(value);
  });
  observe("TASK33_OBSERVE_ADAPTER");
  const adapter = { isSupported: nativeAdapter.isSupported, show: async input => {
    const result = await nativeAdapter.show(input); metrics.shows += 1; observe("TASK33_OBSERVE_SHOW"); return result;
  } };
  client = protocol.createNotificationDeliveryClient({ transport: makeTransport(protocol, metrics), adapter,
    onError: error => process.stderr.write(error instanceof protocol.ElectronProtocolError
      ? "ELECTRON_PROTOCOL_INVALID\n" : "LINUX_AUTHORITY_UNAVAILABLE\n") });
  observe("TASK33_OBSERVE_DRAIN"); await client.start();
  process.stdout.write("TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=" + metrics.claims
    + " shows=" + metrics.shows + " settles=" + metrics.settles + "\n");
  if (pendingLink) await openLink(pendingLink);
}
if (lock) app.whenReady().then(createWindow).catch(() => { process.stderr.write("ELECTRON_OPEN_FAILED\n"); app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on("window-all-closed", () => { client?.close(); if (process.platform !== "darwin") app.quit(); });
`;
}
