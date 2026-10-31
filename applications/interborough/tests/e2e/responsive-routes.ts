/**
 * What the responsive specification (`responsive.spec.ts`) needs to know about the route table
 * without a browser: an address for each route, and the routes not yet made responsive, each naming
 * the issue that owns doing it. `tests/responsive-routes.test.ts` keeps both honest in the unit
 * lane, so a new route cannot be added without an address, and an entry cannot lose its owner.
 */

import { E2E_SKILLS, skillAddressKey } from './skills-support.ts';

/** The identifiers the specification seeds, and so the addresses it can name. */
export interface ResponsiveSeed {
  /** A chat session that exists. */
  readonly chat: string;
  /** An agent whose description is 200 characters long. */
  readonly agent: string;
  /** An agent whose instructions hold a word no line can break at, shown as a document. */
  readonly instructionsAgent: string;
  /** An agent that has a memory with a long unbroken word in it. */
  readonly memoryAgent: string;
  /** A workflow type the engine has registered. */
  readonly workflow: string;
  /** An agent-authored workflow, which has a file and so an editor. */
  readonly workflowFile: string;
  /** A run of that workflow type. */
  readonly run: string;
  /** A schedule. It need not exist: the page says so in a short sentence. */
  readonly schedule: string;
  /** A goal, with the attempts its page lists. */
  readonly goal: string;
  /** The key of a waiting review whose chat has a 300-character unbroken title. */
  readonly review: string;
  /** The key of a decided review, shown under Done. */
  readonly decidedReview: string;
}

/** The address of each route in `routes.ts`, by pattern, with the seeded identifiers filled in. */
export function responsiveAddresses(seed: ResponsiveSeed): Readonly<Record<string, string>> {
  const agent = encodeURIComponent(seed.agent);
  const instructionsAgent = encodeURIComponent(seed.instructionsAgent);
  const memoryAgent = encodeURIComponent(seed.memoryAgent);
  const workflowFile = encodeURIComponent(seed.workflowFile);
  const workflow = encodeURIComponent(seed.workflow);
  const run = encodeURIComponent(seed.run);
  return {
    '/chats': '/chats',
    '/chats/new': '/chats/new',
    '/chats/:chat': `/chats/${encodeURIComponent(seed.chat)}`,
    '/agents': '/agents',
    '/agents/new': '/agents/new',
    '/capabilities': '/capabilities',
    // The agent whose instructions hold a word no line can break at, so the editor's textarea is measured with it.
    '/agents/:agent/edit': `/agents/${instructionsAgent}/edit`,
    '/agents/:agent/memories': `/agents/${memoryAgent}/memories`,
    '/agents/:agent': `/agents/${agent}`,
    '/workflows': '/workflows',
    '/workflows/new': '/workflows/new',
    '/workflows/:workflow': `/workflows/${workflow}`,
    '/workflows/:workflow/runs': `/workflows/${workflow}/runs`,
    '/workflows/:workflow/runs/:run': `/workflows/${workflow}/runs/${run}`,
    '/workflows/:workflow/edit': `/workflows/${workflowFile}/edit`,
    '/internal-workflows': '/internal-workflows',
    '/runs': '/runs',
    '/runs/:run': `/runs/${run}`,
    '/schedules': '/schedules',
    '/schedules/:schedule': `/schedules/${encodeURIComponent(seed.schedule)}`,
    '/reviews': '/reviews',
    '/goals': '/goals',
    '/goals/new': '/goals/new',
    '/goals/:goal': `/goals/${encodeURIComponent(seed.goal)}`,
    '/health': '/health',
    '/health/runs': '/health/runs',
    '/health/workers': '/health/workers',
    '/health/storage': '/health/storage',
    '/health/audit': '/health/audit',
    '/settings': '/settings',
    '/settings/models': '/settings/models',
    '/settings/model-policy': '/settings/model-policy',
    '/settings/data-and-retention': '/settings/data-and-retention',
    '/settings/api-reference': '/settings/api-reference',
  };
}

/**
 * Addresses of a route in a second state, by `<pattern> (<state>)`, each opened and measured like a
 * route of its own. The seeded workflow type is code-defined, so the file header's four buttons
 * (Start run, Pause, Edit, Delete) and a file's Code, Runs and History tabs are reached here,
 * as are an agent's Instructions and Settings tabs, with the tab named in the address (`?tab=`).
 * The Capabilities page's Skills tab, and one seeded long-named skill open, are reached the same way,
 * as are a waiting review open and the Reviews page's Done tab.
 */
export function responsiveVariants(seed: ResponsiveSeed): Readonly<Record<string, string>> {
  const file = `/workflows/${encodeURIComponent(seed.workflowFile)}`;
  const agent = `/agents/${encodeURIComponent(seed.instructionsAgent)}`;
  return {
    '/agents/:agent (instructions tab)': `${agent}?tab=instructions`,
    '/agents/:agent (settings tab)': `${agent}?tab=settings`,
    '/workflows/:workflow (file)': file,
    '/workflows/:workflow (file, code tab)': `${file}?tab=code`,
    '/workflows/:workflow (file, runs tab)': `${file}?tab=runs`,
    '/workflows/:workflow (file, history tab)': `${file}?tab=history`,
    // The Skills tab, and a long-named skill open (one pane at a time below 900px, so at 375 and
    // 768 the detail replaces the list).
    '/capabilities (skills tab)': '/capabilities?tab=skills',
    '/capabilities (skill open)': `/capabilities?tab=skills&skill=${encodeURIComponent(skillAddressKey(E2E_SKILLS.long))}`,
    // A waiting review open (one pane at a time below 900px, so at 375 and 768 the detail replaces
    // the list), and the Done tab with a decided review open.
    '/reviews (review open)': `/reviews?review=${encodeURIComponent(seed.review)}`,
    '/reviews (done tab, review open)': `/reviews?tab=done&review=${encodeURIComponent(seed.decidedReview)}`,
    // Each group of the API reference beside the first, which is the route's own address, and each
    // discovery document, whose tables and diagrams are wider than the groups' first view.
    '/settings/api-reference (discovery)': '/settings/api-reference?group=discovery',
    '/settings/api-reference (openrpc)': '/settings/api-reference?group=discovery&document=openrpc',
    '/settings/api-reference (asyncapi)':
      '/settings/api-reference?group=discovery&document=asyncapi',
    '/settings/api-reference (mcp)': '/settings/api-reference?group=discovery&document=mcp',
    '/settings/api-reference (scopes)': '/settings/api-reference?group=scopes',
    '/settings/api-reference (sources)': '/settings/api-reference?group=sources',
  };
}

/** A route not yet made responsive, and the issue that owns making it so. */
export interface PendingRoute {
  readonly pattern: string;
  /** The Linear issue whose page replaces this one; it removes the entry when the page fits. */
  readonly issue: string;
  /** Widths at which it must overflow, so the entry goes stale when one of them is fixed. Any width, when omitted. */
  readonly failsAt?: readonly number[];
}

/**
 * The routes that still overflow at 375, 768 or 1280 pixels with the seeded long values, each with
 * its owning issue. The list can only shrink: the specification fails a route that fits but is
 * still listed (remove it), and a route that overflows but is not listed (fix it, or list it with
 * its owner). Do not add an entry to ship a regression.
 */
export const pending: readonly PendingRoute[] = [];
