import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import {
  ECHO_NOTHING_TO_REPEAT,
  HUMAN_INPUT_PROMPT,
  HUMAN_INPUT_SIGNAL,
  NEVER_PASSING_VALIDATOR,
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
  test('are the six the host defines, and the host publishes all but internal', async () => {
    const host = await start();
    for (const name of SEEDED_AGENT_NAMES) expect(host.bureau.agents.has(name)).toBe(true);
    expect([...SEEDED_AGENT_NAMES].toSorted()).toEqual([
      'assistant',
      'echo',
      'internal',
      'model-switcher',
      'request-human-input',
      'tool-runner',
    ]);
    expect([...PUBLISHED_AGENT_NAMES].toSorted()).toEqual([
      'assistant',
      'echo',
      'model-switcher',
      'request-human-input',
      'tool-runner',
    ]);
  });

  test('each published agent suggests one prompt, which the agent list carries to a new chat', async () => {
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
    for (const name of PUBLISHED_AGENT_NAMES) {
      expect(examples.get(name)?.length, name).toBe(1);
    }
    expect(examples.get('tool-runner')).toEqual(['Refund order 1234']);
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
      for (const name of ['assistant', 'internal', 'tool-runner'] as const) {
        for (let turn = 0; turn < 3; turn += 1) {
          const result = await host.bureau.run(name, `Message ${turn}`).result();
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
    const assistant = await host.bureau.run('assistant', 'Hello').result();
    expect(assistant.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    const internal = await host.bureau.run('internal', 'Hello').result();
    expect(internal.content).toBe('Internal bookkeeping is done. This reply is scripted.');
  });

  test('echo repeats the last user message it received, quotes and all, and says so when it has none', async () => {
    const host = await start();
    const quoted = '> first excerpt\n\n> second\n> excerpt\n\nWhy does that matter?';
    const echoed = await host.bureau.run('echo', quoted).result();
    expect(echoed.content).toBe(quoted);
    // A second turn on the same agent repeats that turn's message, not the first one.
    const again = await host.bureau.run('echo', 'Another message').result();
    expect(again.content).toBe('Another message');
    // A message with no text leaves nothing to repeat, and the echo says so.
    const nothing = await host.bureau.run('echo', '').result();
    expect(nothing.content).toBe(ECHO_NOTHING_TO_REPEAT);
  });

  test('request-human-input, dispatched without a session, parks and resumes by its run id', async () => {
    const host = await start();
    const run = host.bureau.run('request-human-input', 'Ship it');

    const review = await waitForReview(host, run.id);
    expect(review).toMatchObject({
      kind: 'human-wait',
      runId: run.id,
      agentName: 'request-human-input',
      signalName: HUMAN_INPUT_SIGNAL,
      prompt: HUMAN_INPUT_PROMPT,
    });
    // A catalog run has no session; the run id addresses its review.
    expect(review.sessionId).toBeUndefined();

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

  test('a goal that names the validator that never passes is still going later, and cancelling it ends it as canceled', async () => {
    const host = await start();
    const created = await host.bureau.goals.create({
      goalRunId: 'goal-that-never-passes',
      agentName: 'assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: '1' },
      validator: NEVER_PASSING_VALIDATOR,
      bounds: { maximumAttempts: 3, maximumTotalSteps: 20 },
    });
    expect(created).toMatchObject({ outcome: 'created' });
    const statusOf = async () => {
      const goal = await host.bureau.goals.get('goal-that-never-passes');
      return goal?.status;
    };
    // The agent answers at once, and then the validator is what the goal waits on.
    const deadline = Date.now() + 5_000;
    while ((await statusOf()) !== 'evaluating' && Date.now() < deadline) await Bun.sleep(25);
    expect(await statusOf()).toBe('evaluating');
    await Bun.sleep(400);
    expect(await statusOf()).toBe('evaluating');

    const cancelled = await host.bureau.goals.cancel('goal-that-never-passes');

    expect(['canceled', 'cancellation-pending']).toContain(cancelled.outcome);
    const endBy = Date.now() + 5_000;
    while ((await statusOf()) !== 'canceled' && Date.now() < endBy) await Bun.sleep(25);
    expect(await statusOf()).toBe('canceled');
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

async function waitForReview(host: Host, runId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const review = host.bureau.reviews.list().find((candidate) => candidate.runId === runId);
    if (review !== undefined) return review;
    await Bun.sleep(5);
  }
  throw new Error(`No review was raised for run "${runId}".`);
}

describe('the seeded agents through session runs', () => {
  test('request-human-input parks for an operator and continues once answered', async () => {
    const host = await start();
    const run = await host.bureau.createRun({
      message: 'Ship it',
      agentName: 'request-human-input',
    });

    const review = await waitForReview(host, run.id);
    expect(review).toMatchObject({
      kind: 'human-wait',
      runId: run.id,
      sessionId: run.sessionId,
      agentName: 'request-human-input',
      signalName: HUMAN_INPUT_SIGNAL,
      prompt: HUMAN_INPUT_PROMPT,
    });

    await host.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'anonymous:local',
      payload: { environment: 'staging' },
    });
    const finished = await host.bureau.waitForDurableRun(run.id);
    expect(finished?.status).toBe('completed');
    expect(host.bureau.reviews.list()).toEqual([]);
  });

  test('tool-runner raises its refund approval under the session run, and approving runs it', async () => {
    const host = await start();
    const run = await host.bureau.createRun({
      message: 'Refund order-1001',
      agentName: 'tool-runner',
    });

    const review = await waitForReview(host, run.id);
    expect(review.kind).toBe('tool-approval');
    // The review belongs to the session run itself, not to a constant stand-in for it.
    expect(review.runId).toBe(run.id);
    expect(review.sessionId).toBe(run.sessionId);
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
    const first = await host.bureau.createRun({ message: 'one', agentName: 'request-human-input' });
    await waitForReview(host, first.id);
    const second = await host.bureau.createRun({
      message: 'two',
      agentName: 'request-human-input',
    });

    const review = await waitForReview(host, second.id);

    expect(review).toMatchObject({ kind: 'human-wait', runId: second.id });
  });
});
