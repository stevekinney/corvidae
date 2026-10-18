import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import {
  PUBLISHED_AGENT_NAMES,
  SEEDED_AGENT_NAMES,
  SEEDED_GOAL_RUN_IDENTIFIER,
  SEEDED_SCHEDULE_DESCRIPTION,
} from './seed.ts';

const homes: string[] = [];
const hosts: Host[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-seed-'));
  homes.push(home);
  return home;
}

async function start(home?: string): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home ?? (await createHome()) },
    port: 0,
  });
  hosts.push(host);
  return host;
}

async function goalStatus(host: Host): Promise<string | undefined> {
  const goal = await host.bureau.goals.get(SEEDED_GOAL_RUN_IDENTIFIER);
  return goal?.status;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('the seeded agents', () => {
  test('are the four the host defines, and the host publishes all but internal', async () => {
    const host = await start();
    for (const name of SEEDED_AGENT_NAMES) expect(host.bureau.agents.has(name)).toBe(true);
    expect([...SEEDED_AGENT_NAMES].toSorted()).toEqual([
      'assistant',
      'internal',
      'request-human-input',
      'tool-runner',
    ]);
    expect([...PUBLISHED_AGENT_NAMES].toSorted()).toEqual([
      'assistant',
      'request-human-input',
      'tool-runner',
    ]);
  });

  test('answer from a script, run after run, without calling a model', async () => {
    const host = await start();
    const network: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        network.push(input instanceof Request ? input.url : input.toString());
        return Promise.reject(new Error('The seeded agents must not touch the network.'));
      },
      { preconnect: original.preconnect },
    );
    try {
      for (const name of ['assistant', 'internal', 'request-human-input'] as const) {
        for (let turn = 0; turn < 3; turn += 1) {
          const result = await host.bureau.run(name, `Message ${turn}`).result();
          expect(result.content.length, name).toBeGreaterThan(0);
        }
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(network).toEqual([]);
  });

  test('assistant and internal each give one fixed reply', async () => {
    const host = await start();
    const assistant = await host.bureau.run('assistant', 'Hello').result();
    expect(assistant.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    const internal = await host.bureau.run('internal', 'Hello').result();
    expect(internal.content).toBe('Internal bookkeeping is done. This reply is scripted.');
  });

  test('request-human-input asks its question in plain text, with no schema', async () => {
    const host = await start();
    const result = await host.bureau.run('request-human-input', 'Ship it').result();
    expect(result.content).toBe('Which environment should the release go to? Reply with its name.');
  });

  test('tool-runner looks the order up, then stops on a refund waiting for approval', async () => {
    const host = await start();
    const result = await host.bureau.run('tool-runner', 'Refund order-1001').result();
    const calls = result.steps.flatMap((step) =>
      step.results.map((outcome) => [outcome.toolName, outcome.outcome] as const),
    );
    // The refund did not run: it is held for an operator, and the final report never happened.
    expect(calls).toEqual([
      ['lookup-order', 'success'],
      ['issue-refund', 'action_required'],
    ]);
    const held = result.steps.at(-1)?.results[0];
    expect(held?.pendingApproval).toBeDefined();
    expect(result.content).toBe('');
  });
});

describe('the seeded schedule and goal', () => {
  test('are one schedule and one goal, created once and kept across restarts', async () => {
    const home = await createHome();
    const first = await start(home);
    const schedules = await first.bureau.listSchedules();
    expect(schedules?.items.map((schedule) => schedule.description)).toEqual([
      SEEDED_SCHEDULE_DESCRIPTION,
    ]);
    const firstGoals = await first.bureau.goals.list();
    expect(firstGoals.map((goal) => goal.goalRunId)).toEqual([SEEDED_GOAL_RUN_IDENTIFIER]);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await start(home);
    const again = await second.bureau.listSchedules();
    expect(again?.items.map((schedule) => schedule.id)).toEqual(
      schedules?.items.map((schedule) => schedule.id) ?? [],
    );
    const secondGoals = await second.bureau.goals.list();
    expect(secondGoals.map((goal) => goal.goalRunId)).toEqual([SEEDED_GOAL_RUN_IDENTIFIER]);
  });

  test('an edited seeded schedule is still the seeded one after a restart', async () => {
    const home = await createHome();
    const first = await start(home);
    const listing = await first.bureau.listSchedules();
    const [original] = listing?.items ?? [];
    if (original === undefined) throw new Error('Expected the seeded schedule.');
    const response = await fetch(new URL('/jsonrpc', first.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.schedules.update',
        params: {
          scheduleId: original.id,
          cronExpression: '0 8 * * *',
          description: 'Morning summary',
        },
      }),
    });
    expect(response.status).toBe(200);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await start(home);
    const afterListing = await second.bureau.listSchedules();
    const after = afterListing?.items ?? [];
    expect(after.map((schedule) => [schedule.id, schedule.description])).toEqual([
      [original.id, 'Morning summary'],
    ]);
  });

  test('a seeded schedule an operator deleted stays deleted', async () => {
    const home = await createHome();
    const first = await start(home);
    const listing = await first.bureau.listSchedules();
    const [original] = listing?.items ?? [];
    if (original === undefined) throw new Error('Expected the seeded schedule.');
    await first.bureau.cancelSchedule(original.id);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await start(home);
    const afterListing = await second.bureau.listSchedules();
    const after = afterListing?.items ?? [];
    expect(after.filter((schedule) => schedule.status !== 'cancelled')).toEqual([]);
  });

  test('the goal passes its validator', async () => {
    const host = await start();
    const deadline = Date.now() + 5_000;
    let status = await goalStatus(host);
    while (status !== 'succeeded' && Date.now() < deadline) {
      await Bun.sleep(25);
      status = await goalStatus(host);
    }
    expect(status).toBe('succeeded');
  });

  test('can be left out', async () => {
    const home = await createHome();
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      seed: false,
    });
    hosts.push(host);
    const schedules = await host.bureau.listSchedules();
    expect(schedules?.items).toEqual([]);
    expect(await host.bureau.goals.list()).toEqual([]);
    expect(host.bureau.agents.has('assistant')).toBe(true);
  });
});
