/**
 * What the responsive specification (`responsive.spec.ts`) needs to know about the route table
 * without a browser: an address for each route, and the routes not yet made responsive, each naming
 * the issue that owns doing it. `tests/responsive-routes.test.ts` keeps both honest in the unit
 * lane, so a new route cannot be added without an address, and an entry cannot lose its owner.
 */

import { E2E_CROSS_BUILD_QUEUE, E2E_FLEET_WORKER_ID } from './e2e-constants.ts';
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
  /** The memory of that agent that holds the long unbroken word, opened beside the list. */
  readonly memory: string;
  /** A workflow type the engine has registered. */
  readonly workflow: string;
  /** An agent-authored workflow, which has a file and so an editor. */
  readonly workflowFile: string;
  /** An agent-authored workflow whose input schema holds a field with a 300-character unbroken name and description. */
  readonly runSetupFile: string;
  /** A run of that workflow type. */
  readonly run: string;
  /** A finished run with steps, one named with 120 unbroken characters, and log lines, one with 300. */
  readonly stepsRun: string;
  /** The number of the step of that run whose logged line holds the 300-character value. */
  readonly stepsRunStep: number;
  /** A schedule whose name holds a 300-character unbroken word, read in a zone with a long name. */
  readonly schedule: string;
  /** A goal, with the attempts its page lists. */
  readonly goal: string;
  /** A hook whose sentence holds a 300-character unbroken address, and whose name is long. */
  readonly hook: string;
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
  const runSetupFile = encodeURIComponent(seed.runSetupFile);
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
    '/workflows/:workflow/run': `/workflows/${runSetupFile}/run`,
    '/workflows/:workflow/edit': `/workflows/${workflowFile}/edit`,
    '/internal-workflows': '/internal-workflows',
    '/runs': '/runs',
    '/runs/:run': `/runs/${run}`,
    '/schedules': '/schedules',
    '/schedules/new': '/schedules/new',
    '/schedules/:schedule': `/schedules/${encodeURIComponent(seed.schedule)}`,
    '/schedules/:schedule/edit': `/schedules/${encodeURIComponent(seed.schedule)}/edit`,
    '/reviews': '/reviews',
    '/goals': '/goals',
    '/goals/new': '/goals/new',
    '/goals/:goal': `/goals/${encodeURIComponent(seed.goal)}`,
    '/hooks': '/hooks',
    '/hooks/new': '/hooks/new',
    '/hooks/:hook': `/hooks/${encodeURIComponent(seed.hook)}`,
    '/health': '/health',
    '/health/runs': '/health/runs',
    '/health/workers': '/health/workers',
    '/health/storage': '/health/storage',
    '/health/audit': '/health/audit',
    '/settings': '/settings',
    '/settings/models': '/settings/models',
    '/settings/model-policy': '/settings/model-policy',
    '/settings/plugins': '/settings/plugins',
    '/settings/data-and-retention': '/settings/data-and-retention',
    '/settings/api-reference': '/settings/api-reference',
  };
}

/**
 * Addresses of a route in a second state, by `<pattern> (<state>)`, each opened and measured like a
 * route of its own. The seeded workflow type is code-defined, so the file header's four buttons
 * (Start run, Pause, Edit, Delete) and a file's Code, Runs and History tabs are reached here,
 * as are an agent's Instructions, Access and Settings tabs, with the tab named in the address (`?tab=`).
 * The Capabilities page's Skills tab, and one seeded long-named skill open, are reached the same way,
 * as is the Workers page with the seeded worker open and its Task queues tab with a seeded queue
 * open (its dead letters and recovery diagnostics), and as are a waiting review open and the
 * Reviews page's Done tab, the run setup page opened on a schedule, the picker on Runs, and a run's
 * steps with one open and its whole log shown.
 */
export function responsiveVariants(seed: ResponsiveSeed): Readonly<Record<string, string>> {
  const file = `/workflows/${encodeURIComponent(seed.workflowFile)}`;
  const agent = `/agents/${encodeURIComponent(seed.instructionsAgent)}`;
  return {
    // The memory with the long word open: below 900px the details replace the list, and the text,
    // the three columns of facts and the governance actions are measured.
    '/agents/:agent/memories (memory open)': `/agents/${encodeURIComponent(seed.memoryAgent)}/memories?memory=${encodeURIComponent(seed.memory)}`,
    '/agents/:agent (instructions tab)': `${agent}?tab=instructions`,
    // The Access tab of the agent with the largest budgets the Bureau accepts, a tool set to ask
    // every time, and the host's skills among them, one with a long name.
    '/agents/:agent (access tab)': `${agent}?tab=access`,
    '/agents/:agent (settings tab)': `${agent}?tab=settings`,
    '/workflows/:workflow (file)': file,
    '/workflows/:workflow (file, code tab)': `${file}?tab=code`,
    '/workflows/:workflow (file, runs tab)': `${file}?tab=runs`,
    '/workflows/:workflow (file, history tab)': `${file}?tab=history`,
    // The run setup page for a code-defined type, whose When opens on a schedule (the Schedule
    // builder's Repeats, At and Time zone), and the picker that leads to it from Runs.
    '/workflows/:workflow/run (code, on a schedule)': `/workflows/${encodeURIComponent(seed.workflow)}/run`,
    '/runs (start picker)': '/runs?view=start',
    // The page that makes a schedule with the built-in chat chosen (its agent, message and the chat to continue, whose title is the seeded 300-character word), and with a workflow chosen (its input, and the engine's options).
    '/schedules/new (chat)': '/schedules/new',
    '/schedules/new (workflow)': '/schedules/new',
    // The steps list with the long-named step beside the open step, which holds the 300-character
    // logged value, and the whole log under Details, opened.
    '/runs/:run (steps and logs)': `/runs/${encodeURIComponent(seed.stepsRun)}?step=${String(seed.stepsRunStep)}`,
    // The Skills tab, and a long-named skill open (one pane at a time below 900px, so at 375 and
    // 768 the detail replaces the list).
    // The Workers list with the seeded worker open: its detail is the widest part of the page, and
    // below 900px it replaces the list.
    '/health/workers (worker open)': `/health/workers?worker=${encodeURIComponent(E2E_FLEET_WORKER_ID)}`,
    // A queue open: its strategy, dead letters, recovery diagnostics (the seeded retry storm) and workers.
    '/health/workers (queue open)': `/health/workers?tab=queues&queue=${encodeURIComponent(E2E_CROSS_BUILD_QUEUE)}`,
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
