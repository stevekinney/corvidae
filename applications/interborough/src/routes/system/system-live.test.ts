/**
 * The System views follow the engine's fleet feed (COR-1725): each asks again when the feed reports
 * what it reads, and on its timer only while the feed is not live. The feed is the real source over
 * a stubbed stream (`../live-feeds/live-site.test-support.ts`).
 */
import { queryKeys } from '../../lib/query.ts';
import {
  describeLiveSite,
  mountLiveView,
  type LiveSite,
} from '../live-feeds/live-site.test-support.ts';
import LeaseStatusPanel from './lease-status-panel.svelte';
import RealmsTab from './realms-tab.svelte';
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
