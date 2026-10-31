/**
 * `/runs` and `/runs/:run` follow `bureau.events` instead of polling (COR-1725). Each read the pages
 * make (the tasks, the goals, the chats, one run's task) is asked on a timer only while the Bureau's
 * feed is not live, and once for each event that can change it. The feeds are the real sources over
 * stubbed streams, and TanStack Query's refetch interval is the timer, so the clock is faked and
 * moved by hand.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { TASK_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  contextFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { BureauCall } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  snapshotElement,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { until } from '../../../lib/fake-timers.test-support.ts';
import {
  createLiveFeeds,
  type LiveFeeds,
} from '../../../lib/live-source/live-feeds.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { REVIEW_POLL_MILLISECONDS } from '../../reviews/reviews-data.ts';

let stub: BureauWorldStub | undefined;
let feeds: LiveFeeds | undefined;

beforeEach(() => {
  sessionStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  feeds?.close();
  feeds = undefined;
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
  sessionStorage.clear();
});

function open(path: string, tasks: TaskView[]): void {
  stub = installBureauWorld(emptyBureauWorld({ tasks }));
  stub.on('bureau.goals.list', () => ({ goals: [goalFixture('goal-1')], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({
    contexts: [contextFixture('chat-1', { title: 'Plan the week' })],
    nextOffset: null,
  }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  stub.on('bureau.deployment.get', () => ({ id: 'bureau-1' }));
  feeds = createLiveFeeds();
  landAt(path);
  render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      bureauEvents: feeds.bureauEvents,
      fleetEvents: feeds.fleetEvents,
    },
  } as never);
}

function reads(operation: string, only: (call: BureauCall) => boolean = () => true): number {
  return stub?.callsTo(operation).filter(only).length ?? 0;
}

/** The runs list reads the first page of runs a hundred at a time; the page's probe reads one. */
const hundredAtATime = (call: BureauCall): boolean => call.params['limit'] === 100;
/** The probe behind the view's states reads a single goal; the page reads them all. */
const moreThanOne = (call: BureauCall): boolean => call.params['limit'] !== 1;

const RUN_LIST_SITES = [
  {
    site: 'the runs',
    operation: 'bureau.tasks.list',
    counted: hundredAtATime,
    event: 'run.settled',
  },
  {
    site: 'the goals',
    operation: 'bureau.goals.list',
    counted: moreThanOne,
    event: 'goal.succeeded',
  },
  {
    site: 'the chats',
    operation: 'bureau.contexts.list',
    counted: () => true,
    event: 'session.saved',
  },
] as const;

describe.each(RUN_LIST_SITES)('/runs, reading $site', ({ operation, counted, event }) => {
  const count = () => reads(operation, counted);

  test('asks on a timer while the Bureau’s feed is not live', async () => {
    open('/runs', [taskFixture({ id: 'run-1', contextId: 'chat-1', status: 'completed' })]);
    await until(() => expect(count()).toBe(1));

    await feeds?.passPolls(3, REVIEW_POLL_MILLISECONDS);

    expect(count()).toBeGreaterThanOrEqual(4);
  });

  test('asks on no timer while it is live, and once for each event it reports', async () => {
    open('/runs', [taskFixture({ id: 'run-1', contextId: 'chat-1', status: 'completed' })]);
    await until(() => expect(count()).toBe(1));
    await feeds?.bureauGoesLive();
    const others = RUN_LIST_SITES.filter((other) => other.operation !== operation);
    const othersBefore = others.map((other) => reads(other.operation, other.counted));
    const before = count();

    await feeds?.passPolls(6, REVIEW_POLL_MILLISECONDS);
    expect(count()).toBe(before);

    await feeds?.bureauEvent(event);
    await until(() => expect(count()).toBe(before + 1));
    await feeds?.passPolls(2, REVIEW_POLL_MILLISECONDS);
    expect(count()).toBe(before + 1);
    // The event was this read’s alone: the other two are not asked for it.
    expect(others.map((other) => reads(other.operation, other.counted))).toEqual(othersBefore);
  });

  test('goes back to the timer when the feed is lost', async () => {
    open('/runs', [taskFixture({ id: 'run-1', contextId: 'chat-1', status: 'completed' })]);
    await until(() => expect(count()).toBe(1));
    await feeds?.bureauGoesLive();
    feeds?.hub.end('bureau');
    await until(() => expect(feeds?.bureauEvents.status).toBe('reconnecting'));
    const before = count();

    await feeds?.passPolls(3, REVIEW_POLL_MILLISECONDS);

    expect(count()).toBeGreaterThan(before);
  });
});

describe('/runs/:run, reading the cleanup of a cancelled run', () => {
  const cancelling = () =>
    taskFixture({ id: 'run-1', status: 'working', cleanup: 'cancel-requested' });
  const gets = () => reads('bureau.tasks.get');

  test('asks on a timer while the Bureau’s feed is not live', async () => {
    open('/runs/run-1', [cancelling()]);
    await until(() => expect(gets()).toBe(1));

    await feeds?.passPolls(3, TASK_COPY.cleanupPollMilliseconds);

    expect(gets()).toBeGreaterThanOrEqual(4);
  });

  test('asks on no timer while it is live, and once when the cleanup is acknowledged', async () => {
    open('/runs/run-1', [cancelling()]);
    await until(() => expect(gets()).toBe(1));
    await feeds?.bureauGoesLive();
    const before = gets();

    await feeds?.passPolls(6, TASK_COPY.cleanupPollMilliseconds);
    expect(gets()).toBe(before);

    stub?.on('bureau.tasks.get', () =>
      taskFixture({ id: 'run-1', status: 'canceled', cleanup: null }),
    );
    await feeds?.bureauEvent('task.cleanup-acknowledged', {
      taskId: 'run-1',
      cleanup: 'cleanup-complete',
    });
    await until(() => expect(gets()).toBe(before + 1));
    await feeds?.passPolls(3, TASK_COPY.cleanupPollMilliseconds);
    expect(gets()).toBe(before + 1);
  });
});

describe('/runs/:run, reading a run whose stream ended before it did', () => {
  const going = () => taskFixture({ id: 'run-1', status: 'working' });
  const gets = () => reads('bureau.tasks.get');

  /** The stream carries one snapshot and ends, as a catalog run’s does while it is going. */
  async function endTheStream(): Promise<void> {
    await until(() => expect(stub?.streams.length).toBeGreaterThan(0));
    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    stub?.streams[0]?.end();
    await feeds?.passPolls(1, 0);
  }

  test('asks on a timer while the Bureau’s feed is not live', async () => {
    open('/runs/run-1', [going()]);
    await until(() => expect(gets()).toBeGreaterThanOrEqual(1));
    await endTheStream();
    const before = gets();

    await feeds?.passPolls(3, TASK_COPY.endedPollMilliseconds);

    expect(gets()).toBeGreaterThanOrEqual(before + 3);
  });

  test('asks on no timer while it is live, and once when the run is removed', async () => {
    open('/runs/run-1', [going()]);
    await until(() => expect(gets()).toBeGreaterThanOrEqual(1));
    await feeds?.bureauGoesLive();
    await endTheStream();
    await feeds?.passPolls(1, TASK_COPY.endedPollMilliseconds);
    const before = gets();

    await feeds?.passPolls(6, TASK_COPY.endedPollMilliseconds);
    expect(gets()).toBe(before);

    await feeds?.bureauEvent('run.removed', { runId: 'run-1' });
    await until(() => expect(gets()).toBe(before + 1));
    await feeds?.passPolls(3, TASK_COPY.endedPollMilliseconds);
    expect(gets()).toBe(before + 1);
  });
});
