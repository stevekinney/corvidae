/**
 * COR-2129 — the `audit` interceptor set: a demo run writes one entry per step, keyed by the run
 * and the step, and a step a recovered run replays overwrites its entry rather than adding another.
 */
import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { createPluginStorage } from '@lostgradient/interborough-plugin';
import { pluginContributions } from '@lostgradient/interborough-plugin/testing';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import { auditStepKey, createAuditInterceptor, type AuditStepEntry } from './audit.ts';
import plugin, { createDemoPlugin, DEMO_APPROVAL_SECRET } from './plugin.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const AUDIT_PREFIX = 'plugin:demo:run:';

/** Every audit entry the plugin wrote, by the backing key the host's storage holds it under. */
async function auditEntries(storage: Storage): Promise<Map<string, AuditStepEntry>> {
  const entries = new Map<string, AuditStepEntry>();
  for await (const [key, value] of storage.scan(AUDIT_PREFIX)) {
    entries.set(key, JSON.parse(new TextDecoder().decode(value)) as AuditStepEntry);
  }
  return entries;
}

/** How many audit entries the plugin has written. */
async function entryCount(storage: Storage): Promise<number> {
  const entries = await auditEntries(storage);
  return entries.size;
}

/** The backing keys of the audit entries, sorted. */
async function entryKeys(storage: Storage): Promise<string[]> {
  const entries = await auditEntries(storage);
  return [...entries.keys()].toSorted();
}

async function startDemo(storage: Storage) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    plugins: [
      {
        descriptor: createDemoPlugin({ seedOnStart: false }),
        source: 'package',
        location: '@lostgradient/plugin-demo',
      },
    ],
    pluginConfiguration: { demo: { enabled: true } },
    pluginSecrets: {
      get: async (key) =>
        key === DEMO_APPROVAL_SECRET ? 'fixture-demo-approval-secret' : undefined,
      watch: () => () => {},
    },
    storage,
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the demo audit interceptor set', () => {
  test('is an every-agent set with one effectful onStep hook', async () => {
    const { interceptors } = await pluginContributions(plugin);
    expect(interceptors).toHaveLength(1);
    expect(interceptors?.[0]).toMatchObject({
      name: 'audit',
      appliesTo: 'every-agent',
      onStep: { replay: 'effectful' },
    });
  });

  test('a demo run writes one entry per step, tool-call-only steps included', async () => {
    const storage = new MemoryStorage();
    const bureau = await startDemo(storage);

    const task = await bureau.tasks.start('demo:tool-runner', 'Refund order-1001');
    const result = await task.result();

    // `onStep` settles after the result, so the entries are waited for, not read at once.
    await waitUntil(async () => (await entryCount(storage)) === result.steps.length, {
      message: 'one audit entry for each step of the run',
    });
    const entries = await auditEntries(storage);
    expect(result.steps.length).toBeGreaterThan(1);
    const keys = [...entries.keys()];
    expect(keys.toSorted()).toEqual(
      result.steps.map((step) => `plugin:demo:${auditStepKey(task.id, step.step)}`).toSorted(),
    );
    const first = entries.get(`plugin:demo:${auditStepKey(task.id, 0)}`);
    expect(first).toMatchObject({ step: 0 });
    expect(first?.toolCallIds).toHaveLength(1);
    expect(first?.toolNames).toEqual(['lookup-order']);
    // Every step the Bureau reports carries the id of its run, which is what the key is built from.
    expect(result.steps.map((step) => step.runId)).toEqual(result.steps.map(() => task.id));
  });

  test('keeps the entries of two runs apart', async () => {
    const storage = new MemoryStorage();
    const bureau = await startDemo(storage);

    const first = await bureau.tasks.start('demo:echo', 'one');
    await first.result();
    const second = await bureau.tasks.start('demo:echo', 'two');
    await second.result();

    await waitUntil(async () => (await entryCount(storage)) === 2, {
      message: 'an entry for each of the two runs',
    });
    expect(await entryKeys(storage)).toEqual(
      [
        `plugin:demo:${auditStepKey(first.id, 0)}`,
        `plugin:demo:${auditStepKey(second.id, 0)}`,
      ].toSorted(),
    );
  });

  test('a replayed step overwrites its entry and adds no other', async () => {
    const storage = new MemoryStorage();
    const scoped = createPluginStorage(storage, 'demo');
    const { handler } = (() => {
      const hook = createAuditInterceptor(scoped).onStep;
      if (typeof hook !== 'object')
        throw new TypeError('The audit onStep is declared with options.');
      return hook;
    })();
    const step = {
      step: 3,
      runId: 'replayed-run',
      toolCalls: [{ id: 'call-a', name: 'lookup-order', arguments: {} }],
      usage: { prompt: 1, completion: 2, total: 3 },
    } as unknown as Parameters<typeof handler>[0];

    await handler(step);
    await handler({ ...step, usage: { prompt: 5, completion: 6, total: 11 } });

    const entries = await auditEntries(storage);
    expect([...entries.keys()]).toEqual(['plugin:demo:run:replayed-run:step:3']);
    expect(entries.get('plugin:demo:run:replayed-run:step:3')).toEqual({
      step: 3,
      usage: { prompt: 5, completion: 6, total: 11 },
      toolCallIds: ['call-a'],
      toolNames: ['lookup-order'],
    });
  });

  test('records nothing for a step that carries no run id, rather than inventing a key', async () => {
    const storage = new MemoryStorage();
    const hook = createAuditInterceptor(storage).onStep;
    if (typeof hook !== 'object') throw new TypeError('The audit onStep is declared with options.');

    await hook.handler({ step: 0, toolCalls: [] } as unknown as Parameters<typeof hook.handler>[0]);

    expect(await entryCount(storage)).toBe(0);
  });
});
