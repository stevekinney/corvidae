/**
 * What the showcase specification (`00-showcase.spec.ts`) needs to know about the route table without
 * a browser: an address for each route and for a few of its states, with the identifiers of the
 * sample world's records (`fixtures/sample-world-records.ts`) filled in. `tests/showcase-routes.test.ts`
 * keeps the table honest in the unit lane, so a new route cannot be added without an address.
 */

import type { SampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { E2E_SHOWCASE_EDITABLE_AGENT } from './e2e-constants.ts';

/** The address of each route in `routes.ts`, by pattern, with the sample world's identifiers filled in. */
export function showcaseAddresses(world: SampleWorldRecords): Readonly<Record<string, string>> {
  const agent = encodeURIComponent(world.agent);
  const workflow = encodeURIComponent(world.workflows.releaseNotes);
  const failed = encodeURIComponent(world.runs.failed);
  const chat = encodeURIComponent(world.chats.refund);
  const schedule = encodeURIComponent(world.schedules.dailySummary);
  const goal = encodeURIComponent(world.goals.sayHello);
  const hook = encodeURIComponent(world.hooks.pageOnCall);
  return {
    '/': '/',
    '/chats': '/chats',
    '/chats/new': '/chats/new',
    '/chats/:chat': `/chats/${chat}`,
    '/agents': '/agents',
    '/agents/new': '/agents/new',
    '/capabilities': '/capabilities',
    '/capabilities/connect': '/capabilities/connect',
    '/agents/:agent/edit': `/agents/${encodeURIComponent(E2E_SHOWCASE_EDITABLE_AGENT)}/edit`,
    '/agents/:agent': `/agents/${agent}`,
    '/agents/:agent/instructions': `/agents/${agent}/instructions`,
    '/agents/:agent/access': `/agents/${agent}/access`,
    '/agents/:agent/hooks': `/agents/${agent}/hooks`,
    '/agents/:agent/memory': `/agents/${agent}/memory`,
    '/agents/:agent/settings': `/agents/${agent}/settings`,
    '/workflows': '/workflows',
    '/workflows/new': '/workflows/new',
    '/workflows/:workflow': `/workflows/${workflow}`,
    '/workflows/:workflow/runs': `/workflows/${workflow}/runs`,
    '/workflows/:workflow/runs/:run': `/workflows/${workflow}/runs/${failed}`,
    '/workflows/:workflow/run': `/workflows/${workflow}/run`,
    '/workflows/:workflow/edit': `/workflows/${workflow}/edit`,
    '/internal-workflows': '/internal-workflows',
    '/runs': '/runs',
    '/runs/new': '/runs/new',
    '/runs/:run': `/runs/${encodeURIComponent(world.runs.done)}`,
    '/schedules': '/schedules',
    '/schedules/new': '/schedules/new',
    '/schedules/:schedule': `/schedules/${schedule}`,
    '/schedules/:schedule/edit': `/schedules/${schedule}/edit`,
    '/reviews': '/reviews',
    '/goals': '/goals',
    '/goals/new': '/goals/new',
    '/goals/:goal': `/goals/${goal}`,
    '/goals/:goal/edit': `/goals/${goal}/edit`,
    '/hooks': '/hooks',
    '/hooks/new': '/hooks/new',
    '/hooks/:hook': `/hooks/${hook}`,
    '/health': '/health',
    '/health/runs': '/health/runs',
    '/health/workers': '/health/workers',
    '/health/storage': '/health/storage',
    '/health/audit': '/health/audit',
    '/settings': '/settings',
    '/settings/models': '/settings/models',
    '/settings/allowed-models': '/settings/allowed-models',
    '/settings/a2a': '/settings/a2a',
    '/settings/plugins': '/settings/plugins',
    '/settings/data-and-retention': '/settings/data-and-retention',
    '/settings/api-reference': '/settings/api-reference',
  };
}

/**
 * Addresses of a route in another state, by `<pattern> (<state>)`: the sample world's other chats
 * (the release question, the lookup, the chat a restart ended), Tool runner's Memory tab with a
 * memory open, the page of Release helper, which the disabled Demo plugin ships, on its Chats and
 * Memory tabs, Workflow author, which has no chats, Release notes' tabs and Order refund, which
 * can't load, a run in each state the sample world holds, the Reviews page with a review open, the
 * schedules that are paused, missed runs and can't load, the goals that gave up and were stopped,
 * and the hook that is off. Each is captured like a route of its own.
 */
export function showcaseVariants(world: SampleWorldRecords): Readonly<Record<string, string>> {
  const agent = `/agents/${encodeURIComponent(world.agent)}`;
  // The Demo plugin's Release helper: the sample world keeps Demo off, so the agent is unavailable.
  const heldByPlugin = `/agents/${encodeURIComponent('demo:release-helper')}`;
  const workflow = `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}`;
  const thread = (id: string): string => `/chats/${encodeURIComponent(id)}`;
  const run = (id: string): string => `/runs/${encodeURIComponent(id)}`;
  const schedule = (id: string): string => `/schedules/${encodeURIComponent(id)}`;
  const goal = (id: string): string => `/goals/${encodeURIComponent(id)}`;
  return {
    '/chats/:chat (question waiting)': thread(world.chats.release),
    '/chats/:chat (lookup done)': thread(world.chats.lookUp4468),
    '/chats/:chat (ended by a restart)': thread(world.chats.billing),
    '/agents/:agent/memory (memory open)': `${agent}/memory?selected=${encodeURIComponent(world.memory)}`,
    '/agents/:agent (disabled plugin)': heldByPlugin,
    '/agents/:agent/memory (disabled plugin)': `${heldByPlugin}/memory`,
    '/agents/:agent (no chats)': '/agents/workflow-author',
    '/workflows/:workflow (code tab)': `${workflow}?tab=code`,
    '/workflows/:workflow (runs tab)': `${workflow}?tab=runs`,
    '/workflows/:workflow (history tab)': `${workflow}?tab=history`,
    '/workflows/:workflow (can’t load)': `/workflows/${encodeURIComponent(world.workflows.orderRefund)}`,
    '/runs/:run (failed)': run(world.runs.failed),
    '/runs/:run (waiting on you)': run(world.runs.waiting),
    '/runs/:run (canceled)': run(world.runs.canceled),
    '/reviews (review open)': `/reviews?review=${encodeURIComponent(world.reviews.waiting)}`,
    '/reviews (done tab, review open)': `/reviews?tab=done&review=${encodeURIComponent(world.reviews.decided)}`,
    '/schedules/:schedule (paused)': schedule(world.schedules.inboxTriage),
    '/schedules/:schedule (file-defined)': schedule(world.schedules.releaseNotesDigest),
    '/schedules/:schedule (can’t load)': schedule(world.schedules.weeklyRefundAudit),
    '/goals/:goal (gave up)': goal(world.goals.draftReleaseNotes),
    '/goals/:goal (stopped)': goal(world.goals.summarizeRefunds),
    '/hooks/:hook (off)': `/hooks/${encodeURIComponent(world.hooks.refundAudit)}`,
  };
}

/** Sample world records holding no identifiers, for the parts that need only the names. */
const BLANK_WORLD: SampleWorldRecords = {
  chats: { refund: '', release: '', sayHello: '', lookUp4468: '', billing: '' },
  agent: '',
  memory: '',
  workflows: { releaseNotes: '', triageInbox: '', orderRefund: '' },
  runs: { failed: '', done: '', waiting: '', canceled: '' },
  schedules: { dailySummary: '', inboxTriage: '', releaseNotesDigest: '', weeklyRefundAudit: '' },
  goals: { sayHello: '', draftReleaseNotes: '', summarizeRefunds: '' },
  hooks: {
    pageOnCall: '',
    notifySlack: '',
    triageFinishes: '',
    scheduleMisses: '',
    refundAudit: '',
  },
  reviews: { waiting: '', decided: '' },
  toolSource: '',
};

/** The names of {@link showcaseVariants}, which do not depend on the identifiers, only the addresses do. */
export function showcaseVariantNames(): readonly string[] {
  return Object.keys(showcaseVariants(BLANK_WORLD));
}
