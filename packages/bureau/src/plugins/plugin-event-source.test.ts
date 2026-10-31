/**
 * COR-1879 — events a plugin causes through its own host API carry `source: <plugin>`: the
 * `schedule.created` of a schedule it creates, and every `goal.*` event of a goal it creates, which
 * the goal's record stores. The same calls made through `bureau` carry none.
 */
import { definePlugin, type PluginHostApi } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { eventSourceOf } from '../event-source';
import { GOAL_EVENT_KINDS } from '../events';
import type { Bureau } from '../types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A durable Bureau with plugin `p`, whose setup keeps the host API its context hands it. */
async function start() {
  const held: { host?: PluginHostApi; early?: unknown } = {};
  const plugin = definePlugin({
    name: 'p',
    version: '1.0.0',
    description: 'Creates schedules and goals.',
    setup: async ({ host }) => {
      held.host = host;
      // The Bureau does not exist yet, so the host refuses.
      held.early = await rejectionOf(host.goals.create({} as never));
      return {};
    },
  });
  const bureau = await createBureau<AgentDefinitions>({
    agents: { writer: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }) },
    storage: new MemoryStorage(),
    durable: true,
    validators: [
      {
        identity: { name: 'accepts', version: '1' },
        determinism: 'deterministic',
        validate: async () => ({ kind: 'pass', evidence: [] }),
      },
    ],
    plugins: [{ descriptor: plugin, source: 'package', location: '@example/p' }],
  });
  bureaus.push(bureau);
  await bureau.plugins.ready();
  return { bureau, held };
}

const isTerminal = (kind: string) =>
  ['goal.succeeded', 'goal.exhausted', 'goal.failed', 'goal.canceled'].includes(kind);

const schedule = { agentName: 'writer', input: 'Tick.', spec: '1h' };

describe('the source of an event a plugin causes', () => {
  it('marks schedule.created for a schedule the plugin creates, and not one bureau.schedules creates', async () => {
    const { bureau, held } = await start();
    expect(held.early).toBeInstanceOf(Error);
    const created: unknown[] = [];
    bureau.addEventListener('schedule.created', (event) => created.push(event));

    await held.host!.schedules.create(schedule);
    await bureau.schedules.create(schedule);

    expect(created.map(eventSourceOf)).toEqual(['p', undefined]);
  });

  it('stores the plugin on a goal it creates, so every goal.* event of the goal carries it', async () => {
    const { bureau, held } = await start();
    const sources: (string | undefined)[] = [];
    const kinds: string[] = [];
    for (const kind of GOAL_EVENT_KINDS) {
      bureau.addEventListener(kind, (event) => {
        kinds.push(kind);
        sources.push(eventSourceOf(event));
      });
    }
    const request = {
      agentName: 'writer',
      prompt: 'Go.',
      identity: { name: 'goal', version: '1' },
      validator: { name: 'accepts', version: '1' },
      bounds: { maximumAttempts: 1, maximumTotalSteps: 5 },
    };

    const outcome = await held.host!.goals.create({ ...request, goalRunId: 'from-plugin' });
    expect(outcome.outcome).toBe('created');
    await waitUntil(() => kinds.some(isTerminal), { message: 'the goal to end' });
    expect(kinds).toContain('goal.started');
    expect(kinds).toContain('goal.attempt.started');
    expect(new Set(sources)).toEqual(new Set(['p']));
    expect((await bureau.goals.get('from-plugin'))?.source).toBe('p');

    sources.length = 0;
    kinds.length = 0;
    await bureau.goals.create({ ...request, goalRunId: 'from-core' });
    await waitUntil(() => kinds.some(isTerminal), { message: 'the core goal to end' });
    expect(new Set(sources)).toEqual(new Set([undefined]));
  });
});
