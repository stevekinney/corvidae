/**
 * COR-1764: two Interborough hosts at the same time on one Postgres database and one bucket, the way
 * a rolling deploy overlaps an old release and a new one. Both read the same remote variables, so
 * they agree on one deployment, seed one schedule between them, and share every run.
 *
 * A parks a run on `requestHumanInput` and closes. Closing detaches: A releases its claim on the
 * run and leaves the run parked. B, already running, claims the run on its next claim-renewal tick
 * (at most `workflowClaimRenewIntervalMs`, 5 seconds by default; COR-1763), with no restart and no
 * extra call. B then sees the review, resolves it, and the run completes. The tool that ran before
 * the run parked is never replayed, so its counter stays at 1.
 *
 * The suite needs a live PostgreSQL (`@lostgradient/testing/postgres-server`) and skips without one.
 */
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';
import { openPostgresTestDatabase } from '@lostgradient/testing/postgres-server';
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';
import { createFreshDatabaseUrl, remoteEnvironment } from './remote-backends.test-support.ts';
import { HUMAN_INPUT_PROMPT, HUMAN_INPUT_SIGNAL, SEEDED_GOAL_RUN_IDENTIFIER } from './seed.ts';

const database = await openPostgresTestDatabase();

/** The agent both hosts define: it counts, then asks a person, then thanks them. */
const OVERLAP_AGENT = 'counted-human-input';
const COUNTING_TOOL = 'count-step';

const hosts: Host[] = [];

afterAll(async () => {
  await database?.[Symbol.asyncDispose]();
});

/** The agent: its first step calls the counting tool, its second asks a person, its third thanks them. */
function createOverlapAgents(counter: { count: number }) {
  const countStep = createTool({
    name: COUNTING_TOOL,
    version: '1.0.0',
    description: 'Counts how many times the run executed this step.',
    input: z.object({}),
    metadata: { readOnly: true },
    execute: async () => {
      counter.count += 1;
      return { count: counter.count };
    },
  });
  const generate: GenerateFunction = async ({ conversation }) => {
    const messages = conversation.getMessages();
    const last = messages.at(-1);
    if (
      last?.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith(`[signal:${HUMAN_INPUT_SIGNAL}]`)
    ) {
      return {
        content: 'Thanks, the release will go to the environment you named.',
        toolCalls: [],
      };
    }
    const counted = messages.some((message) => message.toolCall?.name === COUNTING_TOOL);
    if (!counted) {
      return {
        content: '',
        toolCalls: [{ id: 'overlap-count-1', name: COUNTING_TOOL, arguments: {} }],
      };
    }
    return {
      content: '',
      toolCalls: [
        {
          id: 'overlap-request-2',
          name: 'requestHumanInput',
          arguments: { signalName: HUMAN_INPUT_SIGNAL, prompt: HUMAN_INPUT_PROMPT },
        },
      ],
    };
  };
  return {
    [OVERLAP_AGENT]: createAgent({
      name: OVERLAP_AGENT,
      description: 'Counts a step, then asks a human which environment the release goes to.',
      generate,
      toolbox: createToolbox([countStep]),
      stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
    }),
  };
}

function startOverlapHost(environment: Record<string, string>, counter: { count: number }) {
  return startHost({
    environment,
    port: 0,
    extraAgents: { agents: createOverlapAgents(counter) },
  }).then((host) => {
    hosts.push(host);
    return host;
  });
}

describe.skipIf(database === null)('two hosts on one Postgres database and one bucket', () => {
  let server: S3TestServer;

  beforeAll(() => {
    server = createS3TestServer();
  });

  afterEach(async () => {
    mock.restore();
    for (const host of hosts.splice(0)) await host.close();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('share one deployment and one schedule, and B completes the run A parked', async () => {
    const counter = { count: 0 };
    // Bureau reports a goal controller that did not start on the console. Only one host may create
    // the seeded goal (COR-1799), so neither may report it as lost to the other.
    const reported: string[] = [];
    for (const level of ['error', 'warn'] as const) {
      spyOn(console, level).mockImplementation((...parts: unknown[]) => {
        reported.push(parts.map(String).join(' '));
      });
    }
    const environment = remoteEnvironment(
      await createFreshDatabaseUrl(database),
      server,
      `overlap/${crypto.randomUUID()}`,
    );

    const [hostA, hostB] = await Promise.all([
      startOverlapHost(environment, counter),
      startOverlapHost(environment, counter),
    ]);

    expect(hostA.deploymentId).toBe(hostB.deploymentId);
    expect(hostA.database).toMatchObject({ kind: 'postgres' });
    const schedulesOnA = await hostA.bureau.schedules.list();
    const schedulesOnB = await hostB.bureau.schedules.list();
    expect(schedulesOnA?.total).toBe(1);
    expect(schedulesOnB?.total).toBe(1);
    expect(schedulesOnA?.items.map((schedule) => schedule.id)).toEqual(
      schedulesOnB?.items.map((schedule) => schedule.id),
    );

    // The seeded goal runs on whichever host claimed it. Let it finish, so closing A below leaves
    // no goal step in flight against a database pool that is going away.
    await waitUntil(
      async () => {
        const goal = await hostA.bureau.goals.get(SEEDED_GOAL_RUN_IDENTIFIER);
        return goal?.status === 'succeeded';
      },
      { message: 'the seeded goal to succeed' },
    );

    const task = await hostA.bureau.tasks.start(OVERLAP_AGENT, 'Ship the release');
    await waitUntil(() => hostA.bureau.reviews.list().some((review) => review.runId === task.id), {
      message: 'host A to park the run on a review',
    });
    expect(counter.count).toBe(1);

    await hostA.close();
    await waitUntil(() => hostB.bureau.reviews.list().some((review) => review.runId === task.id), {
      message: 'host B to claim the detached run and show its review',
    });
    const review = hostB.bureau.reviews.list().find((candidate) => candidate.runId === task.id);
    expect(review).toMatchObject({ kind: 'human-wait', signalName: HUMAN_INPUT_SIGNAL });

    await hostB.bureau.reviews.resolve({
      id: review?.id ?? '',
      decision: 'approve',
      principal: 'anonymous:local',
      payload: { environment: 'staging' },
    });
    await waitUntil(
      async () => {
        const run = await hostB.bureau.tasks.workflow(task.id);
        return run?.status === 'completed';
      },
      {
        message: 'host B to complete the run',
      },
    );

    await quietFor(250);
    expect(counter.count).toBe(1);
    expect(hostB.bureau.reviews.list()).toEqual([]);
    expect(
      reported.filter(
        (line) =>
          line.includes('WorkflowClaimUnavailableError') &&
          line.includes(`goal:${SEEDED_GOAL_RUN_IDENTIFIER}`),
      ),
    ).toEqual([]);
  });
});
