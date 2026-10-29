/**
 * The Engine view follows the engine's fleet feed (COR-1725): its health probe and its pending
 * reviews ask on a timer only while the feed is not live, and the reviews ask again for each review
 * event. The feed is the real source over a stubbed stream (`../live-site.test-support.ts`).
 */
import { queryKeys } from '../../lib/query.ts';
import { describeLiveSite, mountLiveView } from '../live-site.test-support.ts';
import CriticalAlertsBand from './critical-alerts-band.svelte';
import { ScriptedFetch } from './dashboard-test-support.test-support.ts';
import DashboardIndex from './index.svelte';

const THIRTY_SECONDS = 30_000;

let scripted: ScriptedFetch | undefined;

function restore(): void {
  scripted?.restore();
  scripted = undefined;
}

describeLiveSite('the Engine page’s health probe', {
  intervalMilliseconds: THIRTY_SECONDS,
  // A live feed is the engine answering, so nothing the feed carries asks the probe again.
  watched: [['dashboard', 'health']],
  events: [],
  mount() {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/v1/health', { status: 'ok' });
    scripted.routeJsonRpcMethod('weft.workflows.aggregate', {
      total: 0,
      groups: [],
      truncated: false,
    });
    return mountLiveView({ component: DashboardIndex });
  },
  restore,
});

describeLiveSite('the critical alerts band’s pending reviews', {
  intervalMilliseconds: THIRTY_SECONDS,
  watched: [queryKeys.reviews.list({ status: 'pending' })],
  events: [
    { kind: 'human-review:requested', rereads: [queryKeys.reviews.list({ status: 'pending' })] },
    { kind: 'human-review:completed', rereads: [queryKeys.reviews.list({ status: 'pending' })] },
  ],
  mount() {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: {
        stuckQueued: 0,
        staleInflight: 0,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 0,
        delayed: 0,
        unadoptedTerminal: 0,
      },
    });
    scripted.routeUrl('/v1/reviews', []);
    return mountLiveView({ component: CriticalAlertsBand });
  },
  restore,
});
