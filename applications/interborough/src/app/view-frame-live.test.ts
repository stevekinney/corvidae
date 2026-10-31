/**
 * An empty runs page asks again when the feed that would fill it reports a first run, and on a
 * timer only while that feed is not live (COR-1725): `/runs` follows the Bureau’s `run.registered`,
 * `run.settled` and `goal.started`, and the runs of one workflow type follow the engine’s
 * `workflow:started`. The feeds are the real sources over stubbed streams, and TanStack Query’s
 * refetch interval is the timer, so the clock is faked and moved by hand.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { goalFixture, taskFixture } from '../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../lib/bureau-goals.ts';
import { installBureauStub, type BureauStub } from '../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import { until } from '../lib/fake-timers.test-support.ts';
import { createLiveFeeds, type LiveFeeds } from '../lib/live-source/live-feeds.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  sourceDefinition,
  type WorkflowStub,
} from '../lib/workflow-world.test-support.ts';
import Harness from './view-frame.test-harness.svelte';
import { RUNS_RECHECK_MS } from './view-probes.ts';
import type { ViewName } from './views.ts';

let feeds: LiveFeeds | undefined;
let bureauStub: BureauStub | undefined;
let workflowStub: WorkflowStub | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  feeds?.close();
  feeds = undefined;
  bureauStub?.restore();
  bureauStub = undefined;
  workflowStub?.restore();
  workflowStub = undefined;
  jest.useRealTimers();
});

function mount(view: ViewName, options: { parameters?: Record<string, string>; pattern?: string }) {
  if (feeds === undefined) throw new Error('Open the feeds before mounting a view.');
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      view,
      parameters: options.parameters ?? {},
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
      bureauEvents: feeds.bureauEvents,
      fleetEvents: feeds.fleetEvents,
    },
  } as never);
}

function stateOf(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLElement>('.weft-view')?.dataset['state'];
}

describe('an empty runs page, which follows the Bureau', () => {
  let tasks: TaskView[];
  let goals: Goal[];

  function openRuns() {
    tasks = [];
    goals = [];
    bureauStub = installBureauStub({
      'bureau.tasks.list': () => ({ tasks, nextPageToken: null }),
      'bureau.goals.list': () => ({ goals, nextOffset: null }),
      'bureau.deployment.get': () => ({ id: 'bureau-1' }),
    });
    feeds = createLiveFeeds();
    return mount('runs', {});
  }
  const probes = () => bureauStub?.callsTo('bureau.tasks.list').length ?? 0;

  test('asks again on a timer while the feed is not live, and shows a run that started', async () => {
    const { container } = openRuns();
    await until(() => expect(stateOf(container)).toBe('empty'));
    const asked = probes();

    tasks = [taskFixture({ id: 'run-1', status: 'working' })];
    await feeds?.passPolls(1, RUNS_RECHECK_MS);

    await until(() => expect(stateOf(container)).toBe('ready'));
    expect(probes()).toBeGreaterThan(asked);
  });

  test('asks on no timer while the feed is live', async () => {
    const { container } = openRuns();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.bureauGoesLive();
    const asked = probes();

    await feeds?.passPolls(6, RUNS_RECHECK_MS);

    expect(probes()).toBe(asked);
    expect(stateOf(container)).toBe('empty');
  });

  test.each([
    ['run.registered', () => (tasks = [taskFixture({ id: 'run-1', status: 'working' })])],
    ['run.settled', () => (tasks = [taskFixture({ id: 'run-1', status: 'completed' })])],
    ['goal.started', () => (goals = [goalFixture('goal-1')])],
  ] as const)('asks once when the feed reports %s, and shows what started', async (kind, start) => {
    const { container } = openRuns();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.bureauGoesLive();
    const asked = probes();

    start();
    await feeds?.bureauEvent(kind);

    await until(() => expect(stateOf(container)).toBe('ready'));
    expect(probes()).toBe(asked + 1);
    await feeds?.passPolls(3, RUNS_RECHECK_MS);
    expect(probes()).toBe(asked + 1);
  });

  test('is not asked for an event that cannot add a run', async () => {
    const { container } = openRuns();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.bureauGoesLive();
    const asked = probes();

    await feeds?.bureauEvent('review.requested');
    await feeds?.bureauEvent('session.saved');
    await feeds?.passPolls(2, RUNS_RECHECK_MS);

    expect(probes()).toBe(asked);
  });

  test('goes back to the timer when the feed is lost', async () => {
    const { container } = openRuns();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.bureauGoesLive();
    feeds?.hub.end('bureau');
    await until(() => expect(feeds?.bureauEvents.status).toBe('reconnecting'));
    const asked = probes();

    await feeds?.passPolls(3, RUNS_RECHECK_MS);

    expect(probes()).toBeGreaterThan(asked);
  });
});

describe('the empty runs of a workflow type, which follow the engine', () => {
  const world = () =>
    emptyWorld({
      definitions: [codeDefinition('order-processing'), sourceDefinition('digest')],
      files: [readyFile('digest')],
      runs: [],
    });

  function openType() {
    const empty = world();
    workflowStub = installWorkflowWorld(empty);
    workflowStub.on('bureau.deployment.get', () => ({ id: 'bureau-1' }));
    feeds = createLiveFeeds();
    const view = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow/runs',
    });
    return { empty, ...view };
  }
  const probes = () => workflowStub?.callsTo('GET /workflows').length ?? 0;
  const run = {
    id: 'run-1',
    type: 'order-processing',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  };

  test('asks again on a timer while the fleet feed is not live', async () => {
    const { container } = openType();
    await until(() => expect(stateOf(container)).toBe('empty'));
    const asked = probes();

    await feeds?.passPolls(3, RUNS_RECHECK_MS);

    expect(probes()).toBeGreaterThanOrEqual(asked + 3);
  });

  test('asks on no timer while it is live, and once when a workflow starts', async () => {
    const { container, empty } = openType();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.fleetGoesLive();
    const asked = probes();

    await feeds?.passPolls(6, RUNS_RECHECK_MS);
    expect(probes()).toBe(asked);

    empty.runs.push(run);
    await feeds?.fleetEvent('workflow:started', { workflowId: 'run-1' });

    await until(() => expect(stateOf(container)).toBe('ready'));
    expect(probes()).toBe(asked + 1);
    await feeds?.passPolls(3, RUNS_RECHECK_MS);
    expect(probes()).toBe(asked + 1);
  });

  test('is not asked again for a frame that starts nothing', async () => {
    const { container } = openType();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.fleetGoesLive();
    const asked = probes();

    await feeds?.fleetEvent('workflow:completed', { workflowId: 'run-9' });
    await feeds?.passPolls(2, RUNS_RECHECK_MS);

    expect(probes()).toBe(asked);
  });

  test('is not timed by the Bureau’s feed going live, which is not the one that reports its runs', async () => {
    const { container } = openType();
    await until(() => expect(stateOf(container)).toBe('empty'));
    await feeds?.bureauGoesLive();
    const asked = probes();

    await feeds?.passPolls(3, RUNS_RECHECK_MS);

    expect(probes()).toBeGreaterThanOrEqual(asked + 3);
  });
});
