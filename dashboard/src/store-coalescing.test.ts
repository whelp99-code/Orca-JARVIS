import { afterEach, expect, it } from 'vitest';
import { createHarness, frame } from './store-test-harness.js';
let harness: ReturnType<typeof createHarness> | undefined;
afterEach(() => harness?.store.stop());
it('bounds a synchronous burst of canonical invalidations', async () => {
  const h = harness = createHarness(); h.store.start(); const source = await h.opened;
  const before = h.client.calls.tasks;
  for (let i = 0; i < 1000; i++) source.emit('reconcile', frame('reconcile', ['tasks'], `inst:${i+1}`));
  await h.store.refreshTasks();
  expect(h.client.calls.tasks - before).toBeLessThanOrEqual(2);
});
it('keeps other resources moving and waits for the single follow-up during a held task read', async () => {
  const h = harness = createHarness(); h.store.start(); const source = await h.opened;
  const releases: Array<(data: typeof h.client.data.tasks) => void> = [];
  let active = 0; let maxActive = 0;
  h.client.tasks = async () => {
    active++; maxActive = Math.max(maxActive, active);
    try { return await new Promise(resolve => { releases.push(resolve); }); }
    finally { active--; }
  };
  const before = { ...h.client.calls };
  const first = h.store.refreshTasks();
  for (let i = 0; i < 10_000; i++) source.emit('reconcile', frame('reconcile', [`task:${i}`], `inst:${i+1}`));
  let completed = false;
  const latest = h.store.refreshTasks().then(() => { completed = true; });
  await h.store.refreshApprovals(); await h.store.refreshAgents();
  expect(h.client.calls.controlRequests).toBe(before.controlRequests + 1);
  expect(h.client.calls.agents).toBe(before.agents + 1);
  expect(h.client.calls.task).toBe(before.task);
  expect(releases).toHaveLength(1); expect(completed).toBe(false);
  releases[0]!(h.client.data.tasks); await first;
  expect(releases).toHaveLength(2); expect(completed).toBe(false);
  releases[1]!({ ...h.client.data.tasks, items: [] }); await latest;
  expect(maxActive).toBe(1);
  expect(h.store.getSnapshot().tasks).toMatchObject({ status: 'empty' });
});

it('does not let a delayed snapshot completion undo a newer disconnect', async () => {
  const h = harness = createHarness(); h.store.start(); const source = await h.opened;
  h.client.data.hold = true;
  source.emit('snapshot', frame('snapshot', ['overview', 'tasks', 'agents', 'approvals'], 'inst:1'));
  source.fail();
  const done = h.store.refreshOverview();
  h.client.data.release!(h.client.data.overview);
  await done;
  expect(h.store.getSnapshot().connectionState).toBe('reconnecting');
});

it('aborts the stopped generation, drops its pending reads, and accepts a restarted generation', async () => {
  const h = harness = createHarness(); h.store.start(); await h.opened;
  let signal: AbortSignal | undefined;
  let release!: (data: typeof h.client.data.tasks) => void;
  const original = h.client.tasks;
  const read = async (input?: AbortSignal) => {
    signal = input;
    return await new Promise<typeof h.client.data.tasks>(resolve => { release = resolve; });
  };
  h.client.tasks = read;
  const first = h.store.refreshTasks(); const pending = h.store.refreshTasks();
  const retained = h.store.getSnapshot();
  h.store.stop(); await Promise.all([first, pending]);
  expect(signal?.aborted).toBe(true);
  release({ ...h.client.data.tasks, items: [] }); await Promise.resolve();
  expect(h.store.getSnapshot()).toBe(retained);
  h.client.tasks = original;
  h.store.start(); await h.store.refreshTasks();
  expect(h.store.getSnapshot().tasks).toMatchObject({ status: 'success' });
});
it('does not let an older manual response replace a newer response', async () => {
  const h = harness = createHarness(); h.store.start(); await h.opened;
  const old = h.client.data.tasks;
  const newer = { ...old, items: old.items.map(item => ({ ...item, title: 'newer' })) };
  let release!: (data: typeof old) => void; let calls = 0;
  h.client.tasks = async () => ++calls === 1 ? await new Promise(resolve => { release = resolve; }) : newer;
  const first = h.store.refreshTasks();
  const second = h.store.refreshTasks();
  // Let any unguarded overlapping response settle before releasing the older response.
  await Promise.resolve();
  release(old);
  await Promise.all([first, second]);
  expect(h.store.getSnapshot().tasks).toMatchObject({ data: newer });
});
