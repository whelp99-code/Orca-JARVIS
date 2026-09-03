import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("Electron main source notification boundary", () => {
  it("keeps the production package native and confines the observed adapter to Task33", async () => {
    const url = pathToFileURL(join(process.cwd(), "scripts", "lib", "electron-main-source.mjs")).href;
    const loaded: unknown = await import(url);
    if (typeof loaded !== "object" || loaded === null) throw new TypeError("invalid Electron source module");
    const productionFactory: unknown = Reflect.get(loaded, "electronMainSource");
    const task33Factory: unknown = Reflect.get(loaded, "task33ElectronMainSource");
    if (typeof productionFactory !== "function" || typeof task33Factory !== "function") {
      throw new TypeError("missing Electron source factories");
    }
    const production: unknown = Reflect.apply(productionFactory, undefined, []);
    const task33: unknown = Reflect.apply(task33Factory, undefined, []);
    if (typeof production !== "string" || typeof task33 !== "string") {
      throw new TypeError("invalid Electron source output");
    }

    expect(production).toContain("createElectronNotificationAdapter(Notification");
    expect(production).not.toContain("TASK33_OBSERVED_NOTIFICATION_ADAPTER");
    expect(task33).toContain("TASK33_OBSERVED_NOTIFICATION_ADAPTER");
    expect(task33).not.toContain("createElectronNotificationAdapter(Notification");
    expect(task33).toContain("requestSingleInstanceLock");
  });
});
