import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEMO_AGENT_NAMES,
  HUMAN_INPUT_PROMPT,
  HUMAN_INPUT_SIGNAL,
  NEVER_PASSING,
  SEEDED_GOAL_RUN_IDENTIFIER,
  SEEDED_SCHEDULE_DESCRIPTION,
} from '@lostgradient/plugin-demo';
import { awakeTurns, quietFor } from '@lostgradient/testing/wait-until';

import { enableDemoPlugin } from './demo-plugin.test-support.ts';
import { startHost, type Host } from './host.ts';
import { runTask } from './run-task.test-support.ts';

/** The names the host lists the demo agents under. */
const DEMO_AGENT_IDS = DEMO_AGENT_NAMES.map((name) => `demo:${name}`);

const homes: string[] = [];
const hosts: Host[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-demo-'));
  homes.push(home);
  await enableDemoPlugin(home);
  return home;
}

async function start(home?: string): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home ?? (await createHome()) },
    port: 0,
  });
  hosts.push(host);
  // The plugin seeds the schedule and the goal in `afterStart`, which the host does not wait for.
  await host.bureau.plugins.ready();
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

describe('the demo agents', () => {
  test('are the six the demo plugin defines, and the host serves all of them to chat', async () => {
    const host = await start();
    for (const id of DEMO_AGENT_IDS) expect(host.bureau.agents.has(id)).toBe(true);
    expect([...DEMO_AGENT_IDS].toSorted()).toEqual([
      'demo:assistant',
      'demo:echo',
      'demo:internal',
      'demo:model-switcher',
      'demo:request-human-input',
      'demo:tool-runner',
    ]);
  });

  test('each demo agent suggests one prompt, which the agent list carries to a new chat', async () => {
    const host = await start();
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.agents.list', params: {} }),
    });
    const body = (await response.json()) as {
      result?: { agents: { name: string; examples?: string[] }[] };
    };
    const examples = new Map(body.result?.agents.map((agent) => [agent.name, agent.examples]));
    for (const id of DEMO_AGENT_IDS) {
      expect(examples.get(id)?.length, id).toBe(1);
    }
    expect(examples.get('demo:tool-runner')).toEqual(['Refund order 1234']);
  });

  test('answer from a script, run after run, without calling a model', async () => {
    const host = await start();
    const network: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        network.push(input instanceof Request ? input.url : input.toString());
        return Promise.reject(new Error('The demo agents must not touch the network.'));
      },
      { preconnect: original.preconnect },
    );
    try {
      for (const name of ['demo:assistant', 'demo:internal', 'demo:tool-runner'] as const) {
        for (let turn = 0; turn < 3; turn += 1) {
          const result = await runTask(host.bureau, name, `Message ${turn}`);
          expect(result.steps.length, name).toBeGreaterThan(0);
        }
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(network).toEqual([]);
  });

  test('assistant and internal each give one fixed reply', async () => {
    const host = await start();
    const assistant = await runTask(host.bureau, 'demo:assistant', 'Hello');
    expect(assistant.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    const internal = await runTask(host.bureau, 'demo:internal', 'Hello');
    expect(internal.content).toBe('Internal bookkeeping is done. This reply is scripted.');
  });

  test('echo repeats the last user message it received, quotes and all', async () => {
    const host = await start();
    const quoted = '> first excerpt\n\n> second\n> excerpt\n\nWhy does that matter?';
    const echoed = await runTask(host.bureau, 'demo:echo', quoted);
    expect(echoed.content).toBe(quoted);
    // A second turn on the same agent repeats that turn's message, not the first one.
    const again = await runTask(host.bureau, 'demo:echo', 'Another message');
    expect(again.content).toBe('Another message');
  });

  test('request-human-input parks its task and resumes through the review of its context', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:request-human-input', 'Ship it');

    const review = await waitForReview(host, run.id);
    expect(review).toMatchObject({
      kind: 'human-wait',
      runId: run.id,
      agentName: 'demo:request-human-input',
      signalName: HUMAN_INPUT_SIGNAL,
      prompt: HUMAN_INPUT_PROMPT,
    });
    // The task runs in a context of its own, which its review carries.
    expect(review.sessionId).toBe(run.contextId);

    await host.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'anonymous:local',
      payload: { environment: 'staging' },
    });
    const result = await run.result();
    expect(result.content).toBe('Thanks, the release will go to the environment you named.');
    expect(host.bureau.reviews.list()).toEqual([]);
  });

  test('tool-runner looks the order up, then stops on a refund waiting for approval', async () => {
    const host = await start();
    const result = await runTask(host.bureau, 'demo:tool-runner', 'Refund order-1001');
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

describe('the demo schedule and goal', () => {
  test('are one schedule and one goal, created once and kept across restarts', async () => {
    const home = await createHome();
    const first = await start(home);
    const schedules = await first.bureau.schedules.list();
    expect(schedules?.items.map((schedule) => schedule.description)).toEqual([
      SEEDED_SCHEDULE_DESCRIPTION,
    ]);
    const firstGoals = await first.bureau.goals.list();
    expect(firstGoals.map((goal) => goal.goalRunId)).toEqual([SEEDED_GOAL_RUN_IDENTIFIER]);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await start(home);
    const again = await second.bureau.schedules.list();
    expect(again?.items.map((schedule) => schedule.id)).toEqual(
      schedules?.items.map((schedule) => schedule.id) ?? [],
    );
    const secondGoals = await second.bureau.goals.list();
    expect(secondGoals.map((goal) => goal.goalRunId)).toEqual([SEEDED_GOAL_RUN_IDENTIFIER]);
  });

  test('an edited seeded schedule is still the seeded one after a restart', async () => {
    const home = await createHome();
    const first = await start(home);
    const listing = await first.bureau.schedules.list();
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
    const afterListing = await second.bureau.schedules.list();
    const after = afterListing?.items ?? [];
    expect(after.map((schedule) => [schedule.id, schedule.description])).toEqual([
      [original.id, 'Morning summary'],
    ]);
  });

  test('a seeded schedule an operator deleted stays deleted', async () => {
    const home = await createHome();
    const first = await start(home);
    const listing = await first.bureau.schedules.list();
    const [original] = listing?.items ?? [];
    if (original === undefined) throw new Error('Expected the seeded schedule.');
    await first.bureau.schedules.cancel(original.id);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await start(home);
    const afterListing = await second.bureau.schedules.list();
    const after = afterListing?.items ?? [];
    expect(after.filter((schedule) => schedule.status !== 'cancelled')).toEqual([]);
  });

  test('the goal passes its validator', async () => {
    const host = await start();
    let status = await goalStatus(host);
    for await (const _ of awakeTurns()) {
      if (!(status !== 'succeeded')) break;
      await Bun.sleep(25);
      status = await goalStatus(host);
    }
    expect(status).toBe('succeeded');
  });

  test('a goal that names the validator that never passes is still going later, and cancelling it ends it as canceled', async () => {
    const host = await start();
    const created = await host.bureau.goals.create({
      goalRunId: 'goal-that-never-passes',
      agentName: 'demo:assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: '1' },
      validator: { name: `demo:${NEVER_PASSING.name}`, version: NEVER_PASSING.version },
      bounds: { maximumAttempts: 3, maximumTotalSteps: 20 },
    });
    expect(created).toMatchObject({ outcome: 'created' });
    const statusOf = async () => {
      const goal = await host.bureau.goals.get('goal-that-never-passes');
      return goal?.status;
    };
    for await (const _ of awakeTurns()) {
      if (!((await statusOf()) !== 'evaluating')) break;
      await Bun.sleep(25);
    }
    expect(await statusOf()).toBe('evaluating');
    await quietFor(400);
    expect(await statusOf()).toBe('evaluating');

    const cancelled = await host.bureau.goals.cancel('goal-that-never-passes');

    expect(['canceled', 'cancellation-pending']).toContain(cancelled.outcome);
    for await (const _ of awakeTurns()) {
      if (!((await statusOf()) !== 'canceled')) break;
      await Bun.sleep(25);
    }
    expect(await statusOf()).toBe('canceled');
  });

  test('with the plugin disabled, the host lists no demo agent and seeds no schedule or goal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-demo-off-'));
    homes.push(home);
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(host);
    expect(host.bureau.agents.list().filter(({ id }) => id.startsWith('demo:'))).toEqual([]);
    for (const id of DEMO_AGENT_IDS) expect(host.bureau.agents.has(id)).toBe(false);
    const schedules = await host.bureau.schedules.list();
    expect(schedules?.items).toEqual([]);
    expect(await host.bureau.goals.list()).toEqual([]);
  });
});

async function waitForReview(host: Host, runId: string) {
  for await (const _ of awakeTurns()) {
    const review = host.bureau.reviews.list().find((candidate) => candidate.runId === runId);
    if (review !== undefined) return review;
    await Bun.sleep(5);
  }
  throw new Error(`No review was raised for run "${runId}".`);
}

describe('the demo agents through session runs', () => {
  test('request-human-input parks for an operator and continues once answered', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:request-human-input', 'Ship it');

    const review = await waitForReview(host, run.id);
    expect(review).toMatchObject({
      kind: 'human-wait',
      runId: run.id,
      sessionId: run.contextId,
      agentName: 'demo:request-human-input',
      signalName: HUMAN_INPUT_SIGNAL,
      prompt: HUMAN_INPUT_PROMPT,
    });

    await host.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'anonymous:local',
      payload: { environment: 'staging' },
    });
    const finished = await host.bureau.tasks.wait(run.id);
    expect(finished?.status).toBe('completed');
    expect(host.bureau.reviews.list()).toEqual([]);
  });

  test('tool-runner raises its refund approval under its task, and approving it through the task’s context runs it', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:tool-runner', 'Refund order-1001');

    const review = await waitForReview(host, run.id);
    expect(review.kind).toBe('tool-approval');
    // The review belongs to the task itself, and its context's request context signed the approval.
    expect(review.runId).toBe(run.id);
    expect(review.sessionId).toBe(run.contextId);
    if (review.kind !== 'tool-approval') throw new Error('unreachable');
    expect(review.approval.toolName).toBe('issue-refund');

    const resolved = await host.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'anonymous:local',
    });
    expect(resolved).toMatchObject({ id: review.id, kind: 'tool-approval', decision: 'approve' });
    expect(host.bureau.reviews.list()).toEqual([]);
  });

  test('a second session run starts from the first response again', async () => {
    const host = await start();
    const first = await host.bureau.tasks.start('demo:request-human-input', 'one');
    await waitForReview(host, first.id);
    const second = await host.bureau.tasks.start('demo:request-human-input', 'two');

    const review = await waitForReview(host, second.id);

    expect(review).toMatchObject({ kind: 'human-wait', runId: second.id });
  });
});
