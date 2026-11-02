/**
 * What the showcase specification (`showcase.spec.ts`) needs to know about the route table without
 * a browser: an address for each route and for a few of its states, with the identifiers the
 * showcase seed (`fixtures/showcase-seed.ts`) made filled in. `tests/showcase-routes.test.ts` keeps
 * the table honest in the unit lane, so a new route cannot be added without an address.
 */

import type { ShowcaseSeed } from '../../fixtures/showcase-seed.ts';

/** The address of each route in `routes.ts`, by pattern, with the seeded identifiers filled in. */
export function showcaseAddresses(seed: ShowcaseSeed): Readonly<Record<string, string>> {
  const agent = encodeURIComponent(seed.instructionsAgent);
  const memoryAgent = encodeURIComponent(seed.memoryAgent);
  const digest = encodeURIComponent(seed.workflows.digest);
  const review = encodeURIComponent(seed.workflows.review);
  const succeeded = encodeURIComponent(seed.runs.succeeded);
  const chat = encodeURIComponent(seed.chats['release'] ?? '');
  const schedule = encodeURIComponent(seed.schedules[0] ?? '');
  const goal = encodeURIComponent(seed.goals[0] ?? '');
  const hook = encodeURIComponent(seed.hooks[0] ?? '');
  return {
    '/chats': '/chats',
    '/chats/new': '/chats/new',
    '/chats/:chat': `/chats/${chat}`,
    '/agents': '/agents',
    '/agents/new': '/agents/new',
    '/capabilities': '/capabilities',
    '/agents/:agent/edit': `/agents/${agent}/edit`,
    '/agents/:agent/memories': `/agents/${memoryAgent}/memories`,
    '/agents/:agent/memories/:memory': `/agents/${memoryAgent}/memories/${encodeURIComponent(seed.memory)}`,
    '/agents/:agent': `/agents/${agent}`,
    '/workflows': '/workflows',
    '/workflows/new': '/workflows/new',
    '/workflows/:workflow': `/workflows/${digest}`,
    '/workflows/:workflow/runs': `/workflows/${digest}/runs`,
    '/workflows/:workflow/runs/:run': `/workflows/${digest}/runs/${succeeded}`,
    '/workflows/:workflow/run': `/workflows/${review}/run`,
    '/workflows/:workflow/edit': `/workflows/${digest}/edit`,
    '/internal-workflows': '/internal-workflows',
    '/runs': '/runs',
    '/runs/:run': `/runs/${succeeded}`,
    '/schedules': '/schedules',
    '/schedules/new': '/schedules/new',
    '/schedules/:schedule': `/schedules/${schedule}`,
    '/schedules/:schedule/edit': `/schedules/${schedule}/edit`,
    '/reviews': '/reviews',
    '/goals': '/goals',
    '/goals/new': '/goals/new',
    '/goals/:goal': `/goals/${goal}`,
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
    '/settings/model-policy': '/settings/model-policy',
    '/settings/a2a': '/settings/a2a',
    '/settings/plugins': '/settings/plugins',
    '/settings/data-and-retention': '/settings/data-and-retention',
    '/settings/api-reference': '/settings/api-reference',
  };
}

/**
 * Addresses of a route in another state, by `<pattern> (<state>)`: the chats that hold a tool call,
 * a waiting approval, a question, a picture and a failed run, an agent's tabs, a workflow's tabs,
 * a run in each state it can be in, the Reviews page with a review open, and a paused schedule, a
 * failed hook and a goal that is still evaluating. Each is captured like a route of its own.
 */
export function showcaseVariants(seed: ShowcaseSeed): Readonly<Record<string, string>> {
  const agent = `/agents/${encodeURIComponent(seed.instructionsAgent)}`;
  const file = `/workflows/${encodeURIComponent(seed.workflows.review)}`;
  const thread = (key: string): string => `/chats/${encodeURIComponent(seed.chats[key] ?? '')}`;
  return {
    '/chats/:chat (tool call, approval denied)': thread('refund-denied'),
    '/chats/:chat (approval waiting)': thread('refund-waiting'),
    '/chats/:chat (approval approved)': thread('refund-approved'),
    '/chats/:chat (question waiting)': thread('question'),
    '/chats/:chat (model picker)': thread('model-picker'),
    '/chats/:chat (attachment)': thread('attachment'),
    '/chats/:chat (failed run)': thread('failed'),
    '/agents/:agent (instructions tab)': `${agent}?tab=instructions`,
    '/agents/:agent (access tab)': `${agent}?tab=access`,
    '/agents/:agent (hooks tab)': `${agent}?tab=hooks`,
    '/agents/:agent (settings tab)': `${agent}?tab=settings`,
    '/workflows/:workflow (code tab)': `${file}?tab=code`,
    '/workflows/:workflow (runs tab)': `${file}?tab=runs`,
    '/workflows/:workflow (history tab)': `${file}?tab=history`,
    '/runs/:run (failed)': `/runs/${encodeURIComponent(seed.runs.failed)}`,
    '/runs/:run (running)': `/runs/${encodeURIComponent(seed.runs.running)}`,
    '/runs/:run (cancelled)': `/runs/${encodeURIComponent(seed.runs.cancelled)}`,
    '/reviews (review open)': `/reviews?review=${encodeURIComponent(seed.reviews.waiting)}`,
    '/reviews (done tab, review open)': `/reviews?tab=done&review=${encodeURIComponent(seed.reviews.decided)}`,
    '/schedules/:schedule (paused)': `/schedules/${encodeURIComponent(seed.schedules[2] ?? '')}`,
    '/goals/:goal (evaluating)': `/goals/${encodeURIComponent(seed.goals[1] ?? '')}`,
    '/hooks/:hook (failed delivery)': `/hooks/${encodeURIComponent(seed.hooks[1] ?? '')}`,
  };
}

/** A seed holding no identifiers, for the parts of the specification that need only the names. */
const BLANK_SEED: ShowcaseSeed = {
  agents: [],
  instructionsAgent: '',
  memoryAgent: '',
  memory: '',
  memories: [],
  chats: {},
  workflows: { digest: '', review: '', sync: '' },
  runs: { succeeded: '', failed: '', running: '', cancelled: '' },
  schedules: [],
  hooks: [],
  goals: [],
  reviews: { waiting: '', decided: '' },
  created: [],
};

/** The names of {@link showcaseVariants}, which do not depend on the seed's values, only the addresses do. */
export function showcaseVariantNames(): readonly string[] {
  return Object.keys(showcaseVariants(BLANK_SEED));
}
