/**
 * What the responsive specification (`responsive.spec.ts`) needs to know about the route table
 * without a browser: an address for each route, and the routes not yet made responsive, each naming
 * the issue that owns doing it. `tests/responsive-routes.test.ts` keeps both honest in the unit
 * lane, so a new route cannot be added without an address, and an entry cannot lose its owner.
 */

/** The identifiers the specification seeds, and so the addresses it can name. */
export interface ResponsiveSeed {
  /** A chat session that exists. */
  readonly chat: string;
  /** An agent whose description is 200 characters long. */
  readonly agent: string;
  /** A workflow type the engine has registered. */
  readonly workflow: string;
  /** A run of that workflow type. */
  readonly run: string;
  /** A schedule. It need not exist: the page says so in a short sentence. */
  readonly schedule: string;
}

/** The address of each route in `routes.ts`, by pattern, with the seeded identifiers filled in. */
export function responsiveAddresses(seed: ResponsiveSeed): Readonly<Record<string, string>> {
  const agent = encodeURIComponent(seed.agent);
  const workflow = encodeURIComponent(seed.workflow);
  const run = encodeURIComponent(seed.run);
  return {
    '/chats': '/chats',
    '/chats/new': '/chats/new',
    '/chats/:chat': `/chats/${encodeURIComponent(seed.chat)}`,
    '/agents': '/agents',
    '/agents/new': '/agents/new',
    '/agents/:agent/edit': `/agents/${agent}/edit`,
    '/agents/:agent/memories': `/agents/${agent}/memories`,
    '/agents/:agent': `/agents/${agent}`,
    '/workflows': '/workflows',
    '/workflows/new': '/workflows/new',
    '/workflows/:workflow': `/workflows/${workflow}`,
    '/workflows/:workflow/runs': `/workflows/${workflow}/runs`,
    '/workflows/:workflow/runs/:run': `/workflows/${workflow}/runs/${run}`,
    '/workflows/:workflow/edit': `/workflows/${workflow}/edit`,
    '/runs': '/runs',
    '/runs/:run': `/runs/${run}`,
    '/schedules': '/schedules',
    '/schedules/:schedule': `/schedules/${encodeURIComponent(seed.schedule)}`,
    '/reviews': '/reviews',
    '/goals': '/goals',
    '/health': '/health',
    '/health/runs': '/health/runs',
    '/health/workers': '/health/workers',
    '/health/storage': '/health/storage',
    '/health/audit': '/health/audit',
    '/settings': '/settings',
    '/settings/data-and-retention': '/settings/data-and-retention',
    '/settings/api-reference': '/settings/api-reference',
  };
}

/** A route not yet made responsive, and the issue that owns making it so. */
export interface PendingRoute {
  readonly pattern: string;
  /** The Linear issue whose page replaces this one; it removes the entry when the page fits. */
  readonly issue: string;
}

/**
 * The routes that still overflow at 375, 768 or 1280 pixels with the seeded long values, each with
 * its owning issue. The list can only shrink: the specification fails a route that fits but is
 * still listed (remove it), and a route that overflows but is not listed (fix it, or list it with
 * its owner). Do not add an entry to ship a regression.
 */
export const pending: readonly PendingRoute[] = [];
