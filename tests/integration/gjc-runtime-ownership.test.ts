import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorityDb, GjcRuntimeService } from "../../src/index.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";

const now = "2026-09-07T00:00:00.000Z";
let db: AuthorityDb;
beforeEach(async () => { db = new AuthorityDb(":memory:"); await db.migrate(); });
afterEach(() => db.close());

describe("GJC runtime ownership", () => {
  it("requires the fence to renew even when a caller reuses the same owner label", () => {
    const fence = db.claimGjcRuntimeLease("shared", now)!;
    expect(db.claimGjcRuntimeLease("shared", now)).toBeNull();
    db.heartbeatGjcRuntimeLease("shared", fence, now);
    expect(db.db.prepare("SELECT fence FROM gjc_runtime_leases WHERE id=1").get()).toEqual({ fence });
  });

  it("fences separate service instances with the same worker label", async () => {
    const client = new GjcCoordinatorClient();
    const first = new GjcRuntimeService(db, client, "shared", undefined, () => new Date(now));
    const second = new GjcRuntimeService(db, client, "shared", undefined, () => new Date(now));
    await first.once();
    const lease = db.db.prepare("SELECT owner,fence FROM gjc_runtime_leases WHERE id=1").get();
    await expect(second.once()).resolves.toMatchObject({ state: "leased" });
    await first.once();
    expect(db.db.prepare("SELECT owner,fence FROM gjc_runtime_leases WHERE id=1").get()).toEqual(lease);
  });

  it("releases a completed one-shot without reusing a fence or releasing its successor", async () => {
    const first = new GjcRuntimeService(db, new GjcCoordinatorClient(), "shared", undefined, () => new Date(now));
    const second = new GjcRuntimeService(db, new GjcCoordinatorClient(), "shared", undefined, () => new Date(now));
    await first.once();
    const old = db.db.prepare("SELECT owner,fence FROM gjc_runtime_leases WHERE id=1").get() as { owner: string; fence: number };
    first.close();
    await expect(second.once()).resolves.toMatchObject({ state: "disconnected" });
    const current = db.db.prepare("SELECT owner,fence,expires_at FROM gjc_runtime_leases WHERE id=1").get() as { fence: number };
    expect(current.fence).toBeGreaterThan(old.fence);
    db.releaseGjcRuntimeLease(old.owner, old.fence, now);
    expect(db.db.prepare("SELECT owner,fence,expires_at FROM gjc_runtime_leases WHERE id=1").get()).toEqual(current);
  });

  it("reacquires an expired lease with a new fence", async () => {
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(), "shared");
    await service.once(now);
    const old = db.db.prepare("SELECT fence FROM gjc_runtime_leases WHERE id=1").get() as { fence: number };
    // A cycle stamps its heartbeat at the injected time plus the milliseconds it really took, so a
    // lease taken at 00:00:00 expires a hair after 00:01:00 whenever the cycle is not instant. The
    // boundary instant therefore passed or failed on how busy the machine was; an instant that is
    // unambiguously past the lease asserts the same thing - an expired lease is retaken with a new
    // fence - without asking the clock for a favour.
    await expect(service.once("2026-09-07T00:02:00.000Z")).resolves.toMatchObject({ state: "disconnected" });
    expect(db.db.prepare("SELECT fence FROM gjc_runtime_leases WHERE id=1").get()).toEqual({ fence: old.fence + 1 });
  });

  it("does not overlap cycles on the same instance", async () => {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    let cycles = 0;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(), "shared", async () => {
      cycles++;
      enter();
      await held;
    }, () => new Date(now));
    const first = service.once();
    await entered;
    const second = service.once();
    try {
      expect(cycles).toBe(1);
      expect(() => service.close()).toThrow("GJC_RUNTIME_BUSY");
    } finally {
      resume();
      await first;
    }
    await expect(second).resolves.toMatchObject({ state: "leased" });
  });
});
