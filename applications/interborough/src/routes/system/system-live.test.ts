/**
 * The System views follow the engine's fleet feed (COR-1725): each asks again when the feed reports
 * what it reads, and on its timer only while the feed is not live. The feed is the real source over
 * a stubbed stream (`../live-site.test-support.ts`).
 */
import { queryKeys } from '../../lib/query.ts';
import { describeLiveSite, mountLiveView, type LiveSite } from '../live-site.test-support.ts';
import DynamicSourceList from './dynamic-source-list.svelte';
import LeaseStatusPanel from './lease-status-panel.svelte';
import RealmsTab from './realms-tab.svelte';
import RegistryTab from './registry-tab.svelte';
import SourceLoadDiagnostics from './source-load-diagnostics.svelte';
import { ScriptedFetch } from './system-test-support.test-support.ts';

const THIRTY_SECONDS = 30_000;

/** A site: the view, what its client answers, and what it reads and follows. */
function site(
  view: {
    readonly component: unknown;
    readonly componentProps?: Record<string, unknown>;
    readonly routes: Record<string, unknown>;
  },
  expected: Pick<LiveSite, 'watched' | 'events'>,
): LiveSite {
  let scripted: ScriptedFetch | undefined;
  return {
    ...expected,
    intervalMilliseconds: THIRTY_SECONDS,
    mount() {
      scripted = new ScriptedFetch();
      for (const [method, result] of Object.entries(view.routes)) {
        scripted.routeJsonRpcMethod(method, result);
      }
      return mountLiveView(view);
    },
    restore() {
      scripted?.restore();
      scripted = undefined;
    },
  };
}

const workerList = { items: [], deployments: [], routingPolicy: 'least-loaded' };
const sourceList = {
  sources: [{ name: 'checkout', revision: 'revision-a', kind: 'module', state: 'ready' }],
};
const sourceEvents = [
  'workflow-source:load-started',
  'workflow-source:load-ready',
  'workflow-source:load-failed',
  'workflow-source:load-cancelled',
  'catalog:revision-installed',
  'catalog:revision-activated',
  'catalog:revision-draining',
  'catalog:revision-removed',
];

describeLiveSite(
  'the Realms tab',
  site(
    { component: RealmsTab, routes: { 'weft.realms.diagnostics': { pools: [] } } },
    {
      watched: [queryKeys.realms()],
      events: [{ kind: 'realm:state-changed', rereads: [queryKeys.realms()] }],
    },
  ),
);

describeLiveSite(
  'the engine lease panel',
  site(
    {
      component: LeaseStatusPanel,
      routes: {
        'weft.system.lease': { mode: 'none', status: 'disabled', holdsLease: false },
      },
    },
    {
      watched: [queryKeys.systemLease()],
      events: [{ kind: 'lease:health-changed', rereads: [queryKeys.systemLease()] }],
    },
  ),
);

describeLiveSite(
  'the Registry tab',
  site(
    {
      component: RegistryTab,
      routes: {
        'weft.system.registry': {
          registryVersion: 2,
          generatedAt: '2026-01-01T00:00:00.000Z',
          workflows: [],
          activeRevisions: {},
          activities: {},
        },
        'weft.workers.list': workerList,
        'weft.workers.rejections': { items: [], limit: 25 },
        'weft.catalog.sources.list': { sources: [] },
      },
    },
    {
      watched: [
        queryKeys.registrySnapshot(),
        queryKeys.workers.list(),
        queryKeys.workers.manifests([]),
        queryKeys.workers.rejections(),
      ],
      events: [
        {
          kind: 'worker:connected',
          rereads: [
            queryKeys.registrySnapshot(),
            queryKeys.workers.list(),
            queryKeys.workers.manifests([]),
          ],
        },
        {
          kind: 'worker:disconnected',
          rereads: [
            queryKeys.registrySnapshot(),
            queryKeys.workers.list(),
            queryKeys.workers.manifests([]),
          ],
        },
        { kind: 'worker:registration-rejected', rereads: [queryKeys.workers.rejections()] },
        { kind: 'workflow:definition-registered', rereads: [queryKeys.registrySnapshot()] },
      ],
    },
  ),
);

describeLiveSite(
  'the dynamic source list',
  site(
    {
      component: DynamicSourceList,
      componentProps: { selectedKey: null, onSelect: () => {} },
      routes: { 'weft.catalog.sources.list': sourceList },
    },
    {
      watched: [queryKeys.catalog.sources({ limit: 10, offset: 0 })],
      events: sourceEvents.map((kind) => ({
        kind,
        rereads: [queryKeys.catalog.sources({ limit: 10, offset: 0 })],
      })),
    },
  ),
);

describeLiveSite(
  'a source’s load diagnostics',
  site(
    {
      component: SourceLoadDiagnostics,
      componentProps: { workflowName: 'checkout', revision: 'revision-a' },
      routes: {
        'weft.catalog.diagnostics': {
          name: 'checkout',
          revision: 'revision-a',
          installed: false,
          active: false,
          references: {},
          removable: false,
          source: {
            kind: 'module',
            requestedRevision: 'revision-a',
            state: 'idle',
            waiterCount: 0,
          },
        },
      },
    },
    {
      watched: [queryKeys.catalog.diagnostics('checkout', 'revision-a')],
      events: sourceEvents.map((kind) => ({
        kind,
        rereads: [queryKeys.catalog.diagnostics('checkout', 'revision-a')],
      })),
    },
  ),
);
