/**
 * The showcase seed (`fixtures/showcase-seed.ts`) against a real host started the way the
 * development host starts with `--showcase` (`showcase.ts`): it creates every kind of record it
 * promises, in the states it promises, a second run creates nothing, a run that asks the stub
 * provider to fail fails, and removing the seed leaves the host holding none of it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeShowcase, seedShowcase, type ShowcaseSeed } from '../../fixtures/showcase-seed.ts';
import { startHost, type Host } from './host.ts';
import { prepareShowcaseHome, showcaseProviderResolver } from './showcase.ts';

let home: string;
let host: Host;
let origin: string;
let first: ShowcaseSeed;

/** One Bureau call, as the local caller. */
async function bureau<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${origin}/bureau/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** What the host holds that the seed makes, counted the way the pages list it. */
async function counts(): Promise<Record<string, number>> {
  const agents = await bureau<{ agents: { source: string }[] }>('bureau.agents.definitions.list');
  const contexts = await bureau<{ contexts: { origin: string }[] }>('bureau.contexts.list', {
    limit: 100,
  });
  const schedules = await bureau<{ schedules: { status: string }[] }>('bureau.schedules.list', {
    limit: 100,
  });
  const hooks = await bureau<{ hooks: unknown[] }>('bureau.hooks.list');
  const goals = await bureau<{ goals: unknown[] }>('bureau.goals.list', { limit: 100 });
  const workflows = await bureau<{ workflows: unknown[] }>('bureau.workflows.list');
  return {
    fileAgents: agents.agents.filter((agent) => agent.source === 'file').length,
    chats: contexts.contexts.filter((context) => context.origin === 'chat').length,
    schedules: schedules.schedules.filter((schedule) => schedule.status !== 'cancelled').length,
    hooks: hooks.hooks.length,
    goals: goals.goals.length,
    workflows: workflows.workflows.length,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'interborough-showcase-host-'));
  await prepareShowcaseHome(home);
  host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    resolveProviderGenerate: showcaseProviderResolver(),
    port: 0,
  });
  // The demo plugin seeds its schedule and goal in `afterStart`, which the host does not wait for.
  await host.bureau.plugins.ready();
  origin = host.url.origin;
  first = await seedShowcase(origin);
});

afterAll(async () => {
  await host.close();
  await rm(home, { recursive: true, force: true });
});

describe('the showcase seed on a host', () => {
  test('creates the agents, chats, workflows, schedules, hooks and goals it promises', async () => {
    expect(first.created.length).toBeGreaterThan(20);
    expect(await counts()).toEqual({
      fileAgents: 6,
      chats: 8,
      // The demo plugin's own schedule, and the two of the seed's workflows that run on a schedule.
      schedules: 1 + 3 + 2,
      hooks: 2,
      // The demo plugin's own goal.
      goals: 1 + 2,
      workflows: 3,
    });
  });

  test('puts workflow runs in each state, with the model picker and a failed chat', async () => {
    const statusOf = async (runId: string) => {
      const run = await bureau<{ status: string }>('bureau.workflows.runs.get', { runId });
      return run.status;
    };
    expect(await statusOf(first.runs.succeeded)).toBe('completed');
    expect(await statusOf(first.runs.failed)).toBe('failed');
    expect(await statusOf(first.runs.running)).toBe('running');
    expect(await statusOf(first.runs.cancelled)).toBe('cancelled');
    const tasks = await bureau<{ tasks: { status: string }[] }>('bureau.tasks.list', {
      contextId: first.chats['failed'],
    });
    expect(tasks.tasks.map((task) => task.status)).toEqual(['failed']);
    const models = await bureau<{ models: { model: string }[] }>('bureau.agents.models', {
      agentName: 'demo:model-switcher',
    });
    expect(models.models.length).toBeGreaterThan(1);
  });

  test('leaves one approval waiting and one decided, one hook delivered and one failed', async () => {
    const waiting = await bureau<{ reviews: { id: string }[] }>('bureau.reviews.list', {});
    expect(waiting.reviews.map((review) => `bureau:${review.id}`)).toContain(first.reviews.waiting);
    const resolved = await bureau<{ reviews: { id: string }[] }>('bureau.reviews.list', {
      status: 'resolved',
    });
    expect(resolved.reviews.map((review) => `bureau:${review.id}`)).toContain(
      first.reviews.decided,
    );
    const [delivered, failed] = await Promise.all(
      first.hooks.map((hookId) =>
        bureau<{ deliveries: { status: string }[] }>('bureau.hooks.deliveries', { hookId }),
      ),
    );
    expect(delivered?.deliveries.map((delivery) => delivery.status)).toContain('delivered');
    expect(failed?.deliveries.length).toBeGreaterThan(0);
    expect(failed?.deliveries.map((delivery) => delivery.status)).not.toContain('delivered');
  });

  test('creates nothing the second time, and answers the same identifiers', async () => {
    const before = await counts();
    const second = await seedShowcase(origin);
    expect(second.created).toEqual([]);
    expect(second.chats).toEqual(first.chats);
    expect(second.runs).toEqual(first.runs);
    expect(second.schedules).toEqual(first.schedules);
    expect(second.hooks).toEqual(first.hooks);
    expect(second.goals).toEqual(first.goals);
    expect(await counts()).toEqual(before);
  });

  test('is taken away again by removeShowcase, which a second removal does not mind', async () => {
    await removeShowcase(origin, first);
    await removeShowcase(origin, first);
    expect(await counts()).toEqual({
      fileAgents: 0,
      chats: 0,
      schedules: 1,
      hooks: 0,
      // A goal cannot be deleted, so the two stay, cancelled.
      goals: 1 + 2,
      workflows: 0,
    });
  });
});
