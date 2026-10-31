/**
 * The Workers views follow the engine's fleet feed (COR-1725): each asks again when the feed reports
 * what it reads (a worker connecting, leaving or refused, a deployment changing, a task's attempt or
 * result), and on its timer only while the feed is not live. The feed is the real source over a
 * stubbed stream (`../live-feeds/live-site.test-support.ts`).
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { until } from '../../lib/fake-timers.test-support.ts';
import { queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  describeLiveSite,
  mountLiveView,
  type LiveSite,
} from '../live-feeds/live-site.test-support.ts';
import DeploymentsPanel from './deployments-panel.svelte';
import { routeHappyPaths } from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import {
  ScriptedFetch,
  taskLedgerDetailFixture,
} from './workers-route-test-support.test-support.ts';

const THIRTY_SECONDS = 30_000;
const OPERATION = 'op_ledger_route';

/** The route, on the task's page with a worker selected: every query the route owns is enabled. */
const ROUTE_URL = `/health/workers?tab=diagnostics&task=${OPERATION}&worker=worker-1`;

let scripted: ScriptedFetch | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function workersRoute(): LiveSite {
  const connection = [
    queryKeys.workers.list(),
    queryKeys.workers.manifests([]),
    queryKeys.registrySnapshot(),
    // A queue's connected workers are the workers on it.
    queryKeys.queues.list(),
  ];
  const task = { operationId: OPERATION };
  return {
    intervalMilliseconds: THIRTY_SECONDS,
    watched: [
      ...connection,
      queryKeys.workers.rejections(),
      queryKeys.queues.list(),
      queryKeys.tasks.detail(OPERATION),
      queryKeys.tasks.deliveries(OPERATION),
    ],
    events: [
      { kind: 'worker:connected', rereads: connection },
      { kind: 'worker:disconnected', rereads: connection },
      { kind: 'worker:registration-rejected', rereads: [queryKeys.workers.rejections()] },
      { kind: 'worker:deployment-changed', rereads: [queryKeys.workers.list()] },
      { kind: 'queue:depth-changed', rereads: [queryKeys.queues.list()] },
      { kind: 'workflow:definition-registered', rereads: [queryKeys.registrySnapshot()] },
      {
        kind: 'task:result-delivery',
        payload: task,
        rereads: [queryKeys.tasks.detail(OPERATION), queryKeys.tasks.deliveries(OPERATION)],
      },
      // The queue list's in-flight count is the tasks its workers hold, which these three move.
      {
        kind: 'activity:completed',
        payload: task,
        rereads: [
          queryKeys.tasks.detail(OPERATION),
          queryKeys.tasks.deliveries(OPERATION),
          queryKeys.queues.list(),
        ],
      },
      {
        kind: 'activity:started',
        payload: task,
        rereads: [queryKeys.tasks.detail(OPERATION), queryKeys.queues.list()],
      },
      {
        kind: 'activity:failed',
        payload: task,
        rereads: [queryKeys.tasks.detail(OPERATION), queryKeys.queues.list()],
      },
      {
        kind: 'activity:remote-queued',
        payload: task,
        rereads: [queryKeys.tasks.detail(OPERATION)],
      },
    ],
    mount() {
      scripted = new ScriptedFetch();
      routeHappyPaths(scripted, { workers: [] });
      scripted.routeJsonRpcMethod('weft.system.registry', {
        registryVersion: 2,
        generatedAt: '2026-01-01T00:00:00.000Z',
        workflows: [],
        activeRevisions: {},
        activities: {},
      });
      scripted.routeJsonRpcMethod('weft.tasks.get', taskLedgerDetailFixture());
      scripted.routeJsonRpcMethod('weft.tasks.deliveries', {
        operationId: OPERATION,
        historyLimit: 20,
        droppedCount: 0,
        deliveries: [],
      });
      router.navigate(ROUTE_URL, { replace: true });
      return mountLiveView({ component: WorkersRoute });
    },
    restore() {
      scripted?.restore();
      scripted = undefined;
    },
  };
}

describeLiveSite('the Workers route', workersRoute());

describeLiveSite('the deployments panel', {
  intervalMilliseconds: THIRTY_SECONDS,
  watched: [queryKeys.workers.deployments()],
  // A change an operator made, a build a worker registered, and the work a build is bound to.
  events: [
    'worker:deployment-changed',
    'worker:connected',
    'workflow:started',
    'workflow:completed',
    'workflow:failed',
    'workflow:cancelled',
    'workflow:timed-out',
    'activity:remote-queued',
    'activity:completed',
    'activity:failed',
    'task:dead-lettered',
  ].map((kind) => ({ kind, rereads: [queryKeys.workers.deployments()] })),
  mount() {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.worker.deployments.diagnostics', {
      versions: [],
      routing: null,
    });
    return mountLiveView({ component: DeploymentsPanel, componentProps: { workers: [] } });
  },
  restore() {
    scripted?.restore();
    scripted = undefined;
  },
});

test('the route says it is live, not that it is updated every 30s, while the feed is live', async () => {
  jest.useFakeTimers();
  const site = workersRoute();
  const { feeds, view } = site.mount();
  try {
    await until(() => expect(view.getByText('Updated every 30s')).toBeVisible());
    await feeds.fleetGoesLive();
    await until(() => expect(view.queryByText('Updated every 30s')).toBeNull());
  } finally {
    feeds.close();
    site.restore();
    jest.useRealTimers();
  }
});
